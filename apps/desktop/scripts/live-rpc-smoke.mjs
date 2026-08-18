#!/usr/bin/env node
/**
 * Live JSONL smoke for the desktop host. Speaks `atomic --mode rpc` with a real
 * model so Phase 1 can prove streaming (and abort) without the fixture.
 *
 * Uses whatever provider key is already in the environment. Does not read
 * `~/.atomic`, does not print secret values, and is not part of required CI.
 *
 *   node apps/desktop/scripts/live-rpc-smoke.mjs
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROVIDER_KEYS = [
	"ANTHROPIC_API_KEY",
	"OPENAI_API_KEY",
	"OPENROUTER_API_KEY",
	"GEMINI_API_KEY",
	"XAI_API_KEY",
	"GROQ_API_KEY",
	"MISTRAL_API_KEY",
	"DEEPSEEK_API_KEY",
];

const LIVE_PROMPT_TIMEOUT_MS = 60_000;
const PROMPT = "Reply with the single word: pong";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");

function detectProviderKeyName() {
	for (const name of PROVIDER_KEYS) {
		const value = process.env[name];
		if (typeof value === "string" && value.trim()) return name;
	}
	return null;
}

function bunExecutable() {
	if (process.env.ATOMIC_DESKTOP_BUN) return process.env.ATOMIC_DESKTOP_BUN;
	const home = process.env.HOME || "";
	const candidates = [join(home, ".bun/bin/bun"), "/home/ubuntu/.bun/bin/bun"];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	return "bun";
}

function createClient(child) {
	let buffer = Buffer.alloc(0);
	const frames = [];
	const waiters = [];

	function consume(chunk) {
		buffer = Buffer.concat([buffer, chunk]);
		while (true) {
			const newline = buffer.indexOf(0x0a);
			if (newline === -1) break;
			let frame = buffer.subarray(0, newline);
			buffer = buffer.subarray(newline + 1);
			if (frame.length && frame[frame.length - 1] === 0x0d) frame = frame.subarray(0, -1);
			if (!frame.length) continue;
			let parsed;
			try {
				parsed = JSON.parse(frame.toString("utf8"));
			} catch {
				continue;
			}
			const waiter = waiters.shift();
			if (waiter) waiter(parsed);
			else frames.push(parsed);
		}
	}

	child.stdout.on("data", consume);

	function send(value) {
		child.stdin.write(`${JSON.stringify(value)}\n`);
	}

	function nextFrame(timeoutMs = 8000) {
		return new Promise((resolveFrame, reject) => {
			if (frames.length) {
				resolveFrame(frames.shift());
				return;
			}
			const timer = setTimeout(
				() => reject(new Error(`timed out waiting for live RPC frame after ${timeoutMs}ms`)),
				timeoutMs,
			);
			waiters.push((frame) => {
				clearTimeout(timer);
				resolveFrame(frame);
			});
		});
	}

	async function nextMatching(predicate, timeoutMs) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const frame = await nextFrame(Math.max(1, deadline - Date.now()));
			if (predicate(frame)) return frame;
		}
		throw new Error("timed out waiting for matching live RPC frame");
	}

	return { send, nextFrame, nextMatching };
}

function engineArgs() {
	const cliTs = join(repoRoot, "packages/coding-agent/src/cli.ts");
	return [
		cliTs,
		"--mode",
		"rpc",
		"--no-session",
		"--no-extensions",
		"--name",
		"desktop-live-smoke",
	];
}

async function main() {
	const keyName = detectProviderKeyName();
	if (!keyName) {
		console.error(
			"live-rpc-smoke: no provider API key in the environment. Set one of: " + PROVIDER_KEYS.join(", "),
		);
		process.exit(2);
	}

	const bun = process.env.ATOMIC_DESKTOP_BUN || bunExecutable();
	const child = spawn(bun, engineArgs(), {
		cwd: repoRoot,
		stdio: ["pipe", "pipe", "pipe"],
		env: process.env,
	});

	const stderrChunks = [];
	child.stderr.on("data", (chunk) => {
		stderrChunks.push(String(chunk));
		if (stderrChunks.join("").length > 32 * 1024) stderrChunks.shift();
	});

	const client = createClient(child);
	let exitCode = 1;
	try {
		client.send({ id: "live-state", type: "get_state" });
		const state = await client.nextMatching(
			(frame) => frame.type === "response" && frame.id === "live-state",
			8000,
		);
		if (!state.success) {
			throw new Error(`get_state failed: ${state.error || "unknown"}`);
		}
		const model = state.data?.model;
		const modelLabel = model?.id || model?.name || "unknown";
		console.log(`live-rpc-smoke: using ${keyName}; model ${modelLabel}`);

		client.send({ id: "live-prompt", type: "prompt", message: PROMPT });
		const accepted = await client.nextMatching(
			(frame) => frame.type === "response" && frame.id === "live-prompt",
			8000,
		);
		if (!accepted.success) {
			throw new Error(`prompt rejected: ${accepted.error || "unknown"}`);
		}

		const deltas = [];
		let stopReason = "";
		let assistantText = "";
		const turnDeadline = Date.now() + LIVE_PROMPT_TIMEOUT_MS;
		while (Date.now() < turnDeadline) {
			const frame = await client.nextFrame(Math.max(1, turnDeadline - Date.now()));
			if (frame.type === "message_update" && frame.assistantMessageEvent?.type === "text_delta") {
				deltas.push(frame.assistantMessageEvent.delta || "");
			}
			if (frame.type === "message_end" && frame.message?.role === "assistant") {
				stopReason = frame.message.stopReason || "";
				assistantText =
					typeof frame.message.content === "string"
						? frame.message.content
						: Array.isArray(frame.message.content)
							? frame.message.content
									.filter((block) => block && block.type === "text")
									.map((block) => block.text || "")
									.join("")
							: "";
			}
			if (frame.type === "agent_settled" || frame.type === "agent_end") break;
		}

		const text = (assistantText || deltas.join("")).trim();
		console.log(`live-rpc-smoke: stopReason=${stopReason || "unknown"} text=${JSON.stringify(text)}`);
		if (!/pong/i.test(text)) {
			throw new Error(`expected streamed pong, got ${JSON.stringify(text)}`);
		}
		exitCode = 0;
	} catch (error) {
		const stderr = stderrChunks.join("").trim();
		console.error(error instanceof Error ? error.message : String(error));
		if (stderr) console.error("engine stderr (truncated):\n" + stderr.slice(-4000));
		exitCode = 1;
	} finally {
		try {
			child.stdin.end();
		} catch {
			/* ignore */
		}
		child.kill("SIGTERM");
	}
	process.exit(exitCode);
}

main();
