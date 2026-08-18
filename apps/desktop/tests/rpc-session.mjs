import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LIVE_RPC_TIMEOUT_MS = 120_000;
export const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
export const SOURCE_CLI = path.join(REPO_ROOT, "packages/coding-agent/src/cli.ts");

const SECRET_ENV_NAMES = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_OAUTH_TOKEN"];

export function redact(text) {
	let out = String(text ?? "");
	for (const name of SECRET_ENV_NAMES) {
		const value = process.env[name];
		if (value) out = out.split(value).join(`$${name}`);
	}
	return out;
}

export function hasAnthropicKey() {
	return Boolean((process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_OAUTH_TOKEN || "").trim());
}

export function bunExecutable() {
	if (process.env.BUN && existsSync(process.env.BUN)) return process.env.BUN;
	const home = process.env.HOME ? path.join(process.env.HOME, ".bun/bin/bun") : "";
	if (home && existsSync(home)) return home;
	return "bun";
}

export function defaultLiveArgs() {
	return [
		"--mode",
		"rpc",
		"--no-session",
		"--no-extensions",
		"--provider",
		"anthropic",
		"--model",
		"haiku",
	];
}

export class RpcSession {
	constructor(child) {
		this.child = child;
		this.buf = Buffer.alloc(0);
		this.frames = [];
		this.log = [];
		this.waiters = [];
		this.stderr = "";
		this.seq = 0;
		this.exit = null;
		child.stdout.on("data", (chunk) => this.#push(chunk));
		child.stderr.on("data", (chunk) => {
			this.stderr += chunk.toString("utf8");
			if (this.stderr.length > 64 * 1024) this.stderr = this.stderr.slice(-32 * 1024);
		});
		child.on("error", (error) => {
			this.#failWaiters(new Error(`failed to spawn engine: ${error.message}`));
		});
		child.on("exit", (code, signal) => {
			this.exit = { code, signal };
			this.#failWaiters(new Error(`engine exited (${code ?? signal ?? "unknown"})`));
		});
	}

	#push(chunk) {
		this.buf = Buffer.concat([this.buf, chunk]);
		while (true) {
			const index = this.buf.indexOf(0x0a);
			if (index === -1) break;
			let line = this.buf.subarray(0, index);
			this.buf = this.buf.subarray(index + 1);
			if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, -1);
			if (!line.length) continue;
			let value;
			try {
				value = JSON.parse(line.toString("utf8"));
			} catch (error) {
				this.#failWaiters(new Error(`non-JSON engine line: ${redact(line.toString("utf8"))}: ${error}`));
				return;
			}
			this.#deliver(value);
		}
	}

	#deliver(value) {
		this.log.push(value);
		const index = this.waiters.findIndex((waiter) => waiter.pred(value));
		if (index !== -1) {
			const waiter = this.waiters.splice(index, 1)[0];
			waiter.resolve(value);
			return;
		}
		this.frames.push(value);
	}

	mark() {
		return this.log.length;
	}

	since(index) {
		return this.log.slice(index);
	}

	#failWaiters(error) {
		const waiters = this.waiters.splice(0);
		for (const waiter of waiters) waiter.reject(error);
	}

	send(value) {
		if (!this.child.stdin || this.child.stdin.destroyed) {
			throw new Error("engine stdin is closed");
		}
		this.child.stdin.write(`${JSON.stringify(value)}\n`);
	}

	wait(pred, timeoutMs = 30_000, since) {
		const haystack = since == null ? this.frames : this.log.slice(since);
		const existing = haystack.findIndex(pred);
		if (existing !== -1) {
			if (since == null) return Promise.resolve(this.frames.splice(existing, 1)[0]);
			return Promise.resolve(haystack[existing]);
		}
		return new Promise((resolve, reject) => {
			const waiter = {
				pred,
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			};
			const timer = setTimeout(() => {
				const index = this.waiters.indexOf(waiter);
				if (index !== -1) this.waiters.splice(index, 1);
				reject(
					new Error(
						`timeout waiting for RPC frame. stderr: ${redact(this.stderr)} types: ${this.log
							.slice(-(since == null ? 20 : Math.max(20, this.log.length - since)))
							.map((frame) => frame.type)
							.join(",")}`,
					),
				);
			}, timeoutMs);
			this.waiters.push(waiter);
		});
	}

	async request(command, timeoutMs = 30_000) {
		const id = command.id || `req-${++this.seq}`;
		this.send({ ...command, id });
		const response = await this.wait((frame) => frame.type === "response" && frame.id === id, timeoutMs);
		if (!response.success) {
			throw new Error(redact(response.error || `${command.type} failed`));
		}
		return response;
	}

	collected(pred) {
		return this.frames.filter(pred);
	}

	async close() {
		try {
			this.child.stdin.end();
		} catch {
			// already closed
		}
		if (this.child.exitCode === null && this.child.signalCode === null) {
			this.child.kill("SIGTERM");
			await Promise.race([
				new Promise((resolve) => this.child.once("exit", resolve)),
				new Promise((resolve) => setTimeout(resolve, 2000)),
			]);
		}
		if (this.child.exitCode === null && this.child.signalCode === null) {
			this.child.kill("SIGKILL");
		}
	}
}

export function spawnLiveEngine(options = {}) {
	const cwd = options.cwd || mkdtempSync(path.join(tmpdir(), "atomic-desktop-live-"));
	const agentDir = options.agentDir || mkdtempSync(path.join(tmpdir(), "atomic-desktop-agent-"));
	const bun = bunExecutable();
	const args = [SOURCE_CLI, ...(options.args || defaultLiveArgs())];
	const child = spawn(bun, args, {
		cwd,
		env: {
			...process.env,
			ATOMIC_CODING_AGENT_DIR: agentDir,
			PI_CODING_AGENT_DIR: agentDir,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	child.on("error", (error) => {
		child.emit("exit", null, error.message);
	});
	return { session: new RpcSession(child), cwd, agentDir, child };
}

export async function waitForAgentEnd(session, timeoutMs = LIVE_RPC_TIMEOUT_MS, since) {
	return session.wait((frame) => frame.type === "agent_end", timeoutMs, since);
}

export async function waitReady(session) {
	let lastError;
	for (let attempt = 0; attempt < 8; attempt += 1) {
		try {
			return await session.request({ type: "get_state" }, 8_000);
		} catch (error) {
			lastError = error;
			if (session.exit) throw error;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
	throw lastError;
}
