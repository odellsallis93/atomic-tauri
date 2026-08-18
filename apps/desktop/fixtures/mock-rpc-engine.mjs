#!/usr/bin/env node
/**
 * Fixture RPC engine for the Atomic desktop proof of concept.
 *
 * Speaks the public `--mode rpc` JSONL shape on stdin/stdout so the Tauri host
 * can prove streaming, tools, abort, and confirm dialogs without a live model.
 * It is not a substitute for Atomic. Do not point production hosts at it.
 *
 * Usage:
 *   node apps/desktop/fixtures/mock-rpc-engine.mjs [--scenario stream|tool|confirm|select|abort]
 *
 * Scenario can also be selected per prompt:
 *   "stream" / default  -> streamed assistant text
 *   "tool"              -> bash tool card then a short reply
 *   "confirm"           -> blocking extension confirm, then a tool if allowed
 *   "select"            -> blocking extension select, then a tool if Allow
 *   "abort"             -> slow stream that abort can cut off
 *
 * Abort and extension_ui_response are handled while a prompt is in flight.
 * Sequential command handling would deadlock confirm and make abort a no-op.
 */

import { stdin, stdout } from "node:process";

const args = process.argv.slice(2);
let defaultScenario = "stream";
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--scenario" && args[i + 1]) {
		defaultScenario = args[++i];
		continue;
	}
	if (args[i] === "--mode" || args[i] === "rpc" || args[i] === "--mode=rpc") continue;
}

const sessionId = "fixture-session";
let isStreaming = false;
let abortRequested = false;
let confirmWaiter = null;
let buffer = Buffer.alloc(0);

function writeFrame(value) {
	stdout.write(`${JSON.stringify(value)}\n`);
}

function ok(id, command, data) {
	if (data === undefined) writeFrame({ id, type: "response", command, success: true });
	else writeFrame({ id, type: "response", command, success: true, data });
}

function fail(id, command, error) {
	writeFrame({ id, type: "response", command, success: false, error });
}

function state() {
	return {
		model: {
			id: "fixture/mock",
			name: "Fixture",
			api: "unknown",
			provider: "fixture",
			baseUrl: "",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 256,
		},
		thinkingLevel: "off",
		isStreaming,
		isCompacting: false,
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
		sessionId,
		autoCompactionEnabled: false,
		messageCount: 0,
		pendingMessageCount: 0,
		queuedMessagesPaused: false,
	};
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function chooseScenario(message) {
	const text = String(message || "").toLowerCase();
	if (/\bselect\b/.test(text) || /\bchoose\b/.test(text)) return "select";
	if (/\bconfirm\b/.test(text)) return "confirm";
	if (/\babort\b/.test(text) || /\bslow\b/.test(text)) return "abort";
	if (/\btool\b/.test(text) || /\bpwd\b/.test(text)) return "tool";
	if (/\bstream\b/.test(text) || /\bpong\b/.test(text)) return "stream";
	return defaultScenario;
}

async function emitText(text) {
	writeFrame({
		type: "message_start",
		message: { role: "assistant", content: [], stopReason: "pending", timestamp: Date.now() },
	});
	writeFrame({
		type: "message_update",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
		assistantMessageEvent: { type: "text_start", contentIndex: 0 },
	});
	for (const chunk of text.match(/.{1,8}/g) || [text]) {
		if (abortRequested) return false;
		writeFrame({
			type: "message_update",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: chunk },
		});
		await sleep(20);
	}
	writeFrame({
		type: "message_update",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
		assistantMessageEvent: { type: "text_end", contentIndex: 0, content: text },
	});
	writeFrame({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			stopReason: "stop",
			timestamp: Date.now(),
		},
	});
	return true;
}

async function emitTool() {
	const toolCallId = "call_fixture_pwd";
	writeFrame({
		type: "tool_execution_start",
		toolCallId,
		toolName: "bash",
		args: { command: "pwd" },
	});
	writeFrame({
		type: "tool_execution_update",
		toolCallId,
		toolName: "bash",
		args: { command: "pwd" },
		partialResult: { content: [{ type: "text", text: "/workspace" }] },
	});
	writeFrame({
		type: "tool_execution_end",
		toolCallId,
		toolName: "bash",
		args: { command: "pwd" },
		isError: false,
		result: { content: [{ type: "text", text: "/workspace\n" }] },
	});
}

async function runTurn(message) {
	isStreaming = true;
	abortRequested = false;
	writeFrame({ type: "agent_start" });
	writeFrame({
		type: "message_start",
		message: { role: "user", content: message, timestamp: Date.now() },
	});

	const scenario = chooseScenario(message);
	try {
		if (scenario === "confirm") {
			const requestId = "ui-fixture-1";
			writeFrame({
				type: "extension_ui_request",
				id: requestId,
				method: "confirm",
				title: "Allow fixture command?",
				message: "The fixture wants to run `pwd`. This is a canned confirm, not a real sandbox prompt.",
			});
			const answer = await new Promise((resolve) => {
				confirmWaiter = resolve;
			});
			confirmWaiter = null;
			if (answer && answer.confirmed) {
				await emitTool();
				const finished = await emitText("Allowed. Fixture ran pwd.");
				if (!finished) throw new Error("aborted");
			} else {
				const finished = await emitText("Cancelled.");
				if (!finished) throw new Error("aborted");
			}
		} else if (scenario === "select") {
			const requestId = "ui-fixture-select";
			writeFrame({
				type: "extension_ui_request",
				id: requestId,
				method: "select",
				title: "Allow fixture command?",
				message: "Pick Allow to run the canned pwd tool card.",
				options: ["Allow", "Deny"],
			});
			const answer = await new Promise((resolve) => {
				confirmWaiter = resolve;
			});
			confirmWaiter = null;
			if (answer && answer.value === "Allow") {
				await emitTool();
				const finished = await emitText("Allowed. Fixture ran pwd.");
				if (!finished) throw new Error("aborted");
			} else {
				const finished = await emitText("Denied.");
				if (!finished) throw new Error("aborted");
			}
		} else if (scenario === "tool") {
			const started = await emitText("I will run pwd.");
			if (!started) throw new Error("aborted");
			await emitTool();
			const finished = await emitText("Done.");
			if (!finished) throw new Error("aborted");
		} else if (scenario === "abort") {
			writeFrame({
				type: "message_start",
				message: { role: "assistant", content: [], stopReason: "pending", timestamp: Date.now() },
			});
			writeFrame({
				type: "message_update",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
				assistantMessageEvent: { type: "text_start", contentIndex: 0 },
			});
			let text = "";
			for (let i = 0; i < 80; i++) {
				if (abortRequested) break;
				const delta = "tick ";
				text += delta;
				writeFrame({
					type: "message_update",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
					assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
				});
				await sleep(40);
			}
			const aborted = abortRequested;
			writeFrame({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text }],
					stopReason: aborted ? "aborted" : "stop",
					errorMessage: aborted ? "Operation aborted" : undefined,
					timestamp: Date.now(),
				},
			});
		} else {
			const finished = await emitText("pong");
			if (!finished) throw new Error("aborted");
		}
	} catch {
		writeFrame({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "" }],
				stopReason: "aborted",
				errorMessage: "Operation aborted",
				timestamp: Date.now(),
			},
		});
	}

	isStreaming = false;
	writeFrame({ type: "agent_end" });
	writeFrame({ type: "agent_settled" });
}

async function handleCommand(command) {
	const id = command.id;
	const type = command.type;
	switch (type) {
		case "get_state":
			ok(id, type, state());
			return;
		case "get_messages":
			ok(id, type, { messages: [] });
			return;
		case "abort":
			abortRequested = true;
			if (confirmWaiter) confirmWaiter({ cancelled: true });
			ok(id, type);
			return;
		case "steer":
		case "follow_up":
			writeFrame({
				type: "queue_update",
				steering: type === "steer" ? [command.message] : [],
				followUp: type === "follow_up" ? [command.message] : [],
			});
			ok(id, type);
			return;
		case "prompt":
			if (isStreaming && command.streamingBehavior === "steer") {
				writeFrame({ type: "queue_update", steering: [command.message], followUp: [] });
				ok(id, type);
				return;
			}
			if (isStreaming && command.streamingBehavior === "followUp") {
				writeFrame({ type: "queue_update", steering: [], followUp: [command.message] });
				ok(id, type);
				return;
			}
			if (isStreaming) {
				fail(id, type, "agent is streaming; set streamingBehavior to steer or followUp");
				return;
			}
			ok(id, type);
			await runTurn(command.message || "");
			return;
		case "extension_ui_response":
			if (confirmWaiter) confirmWaiter(command);
			return;
		default:
			fail(id, type || "unknown", `fixture does not implement ${type}`);
	}
}

function consume(chunk) {
	buffer = Buffer.concat([buffer, chunk]);
	const frames = [];
	while (true) {
		const newline = buffer.indexOf(0x0a);
		if (newline === -1) break;
		let frame = buffer.subarray(0, newline);
		buffer = buffer.subarray(newline + 1);
		if (frame.length && frame[frame.length - 1] === 0x0d) frame = frame.subarray(0, -1);
		if (frame.length) frames.push(frame.toString("utf8"));
	}
	return frames;
}

stdin.on("data", (chunk) => {
	for (const line of consume(Buffer.from(chunk))) {
		let command;
		try {
			command = JSON.parse(line);
		} catch {
			fail(undefined, "unknown", `invalid JSON: ${line}`);
			continue;
		}
		void handleCommand(command).catch((error) => {
			fail(
				command.id,
				command.type || "unknown",
				error instanceof Error ? error.message : String(error),
			);
		});
	}
});
stdin.on("end", () => {
	process.exit(0);
});
