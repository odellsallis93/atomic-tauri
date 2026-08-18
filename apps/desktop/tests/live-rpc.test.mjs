import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { readFileSync } from "node:fs";
import {
	LIVE_RPC_TIMEOUT_MS,
	hasAnthropicKey,
	redact,
	spawnLiveEngine,
	waitForAgentEnd,
	waitReady,
} from "./rpc-session.mjs";

const skip = !hasAnthropicKey();
const skipReason = "ANTHROPIC_API_KEY / ANTHROPIC_OAUTH_TOKEN unset";

function loadAssembler() {
	const source = readFileSync(new URL("../src/session.js", import.meta.url), "utf8");
	new Function(source)();
	return globalThis.AtomicSession;
}

const AtomicSession = loadAssembler();
let engine;

function live(name, fn) {
	test(name, { skip, timeout: LIVE_RPC_TIMEOUT_MS }, async (t) => {
		if (skip) {
			t.skip(skipReason);
			return;
		}
		try {
			await fn(t);
		} catch (error) {
			error.message = redact(error.message);
			throw error;
		}
	});
}

describe("live RPC against Anthropic Haiku", { concurrency: 1, skip }, () => {
	before(async () => {
		if (skip) return;
		engine = spawnLiveEngine();
		const state = await waitReady(engine.session);
		assert.equal(state.data?.model?.provider, "anthropic");
	});

	after(async () => {
		if (engine) await engine.session.close();
	});

	live("get_state returns an authenticated Anthropic Haiku session", async () => {
		const state = await engine.session.request({ type: "get_state" });
		assert.equal(state.command, "get_state");
		assert.ok(state.data);
		assert.equal(state.data.model?.provider, "anthropic");
		assert.match(String(state.data.model?.id || ""), /haiku/i);
		assert.equal(state.data.isStreaming, false);
		assert.ok(state.data.sessionId);
		assert.equal(state.data.sessionFile, undefined);
	});

	live("prompt streams text_delta and the assembler renders the reply", async () => {
		await engine.session.request({ type: "new_session" });
		const session = AtomicSession.createSession();
		const prompt = "Reply with the single word: pong";
		const mark = engine.session.mark();
		AtomicSession.noteLocalUser(session, prompt);
		await engine.session.request({ type: "prompt", message: prompt });
		await engine.session.wait(
			(frame) =>
				frame.type === "message_update" &&
				frame.assistantMessageEvent &&
				frame.assistantMessageEvent.type === "text_delta",
			LIVE_RPC_TIMEOUT_MS,
		);
		await waitForAgentEnd(engine.session);
		for (const frame of engine.session.since(mark)) {
			if (frame.type === "response") continue;
			AtomicSession.handleEvent(session, frame);
		}
		const assistant = session.items.filter((item) => item.kind === "assistant");
		assert.ok(assistant.length >= 1, "expected an assistant bubble");
		assert.match(assistant.map((item) => item.text).join("\n"), /pong/i);
	});

	live("bash tool turn reports tool_execution events and pwd output", async () => {
		await engine.session.request({ type: "new_session" });
		const prompt =
			"Use the bash tool to run the command pwd. Then reply with only the directory path from that output.";
		const mark = engine.session.mark();
		await engine.session.request({ type: "prompt", message: prompt });
		const toolStart = await engine.session.wait(
			(frame) => frame.type === "tool_execution_start",
			LIVE_RPC_TIMEOUT_MS,
		);
		assert.equal(toolStart.toolName, "bash");
		await engine.session.wait(
			(frame) => frame.type === "tool_execution_end" && frame.toolCallId === toolStart.toolCallId,
			LIVE_RPC_TIMEOUT_MS,
		);
		await waitForAgentEnd(engine.session);
		assert.equal(
			engine.session.since(mark).filter((frame) => frame.type === "extension_ui_request").length,
			0,
		);

		const session = AtomicSession.createSession();
		for (const frame of engine.session.since(mark)) {
			if (frame.type === "response") continue;
			AtomicSession.handleEvent(session, frame);
		}
		const tool = session.items.find((item) => item.kind === "tool");
		assert.ok(tool);
		assert.equal(tool.phase, "done");
		assert.ok(
			String(tool.output).includes(engine.cwd) || JSON.stringify(tool.args || {}).includes("pwd"),
			"expected pwd tool args or output",
		);
	});

	live("abort during a long bash tool call ends the turn", async () => {
		await engine.session.request({ type: "new_session" });
		const prompt = "Use the bash tool to run sleep 25. After it finishes, reply with the single word: done.";
		const mark = engine.session.mark();
		await engine.session.request({ type: "prompt", message: prompt });
		await engine.session.wait((frame) => frame.type === "tool_execution_start", LIVE_RPC_TIMEOUT_MS);
		const aborted = await engine.session.request({ type: "abort" });
		assert.equal(aborted.command, "abort");
		const ended = await waitForAgentEnd(engine.session);
		const turn = engine.session.since(mark);
		const stopReasons = (ended.messages || [])
			.filter((message) => message.role === "assistant")
			.map((message) => message.stopReason);
		const sawAbort =
			stopReasons.includes("aborted") ||
			turn.some((frame) => frame.type === "message_end" && frame.message?.stopReason === "aborted") ||
			turn.some((frame) => frame.type === "tool_execution_end" && frame.isError);
		assert.ok(sawAbort, `expected abort evidence, stopReasons=${stopReasons.join(",")}`);

		const session = AtomicSession.createSession();
		for (const frame of turn) {
			if (frame.type === "response") continue;
			AtomicSession.handleEvent(session, frame);
		}
		assert.ok(
			session.items.some((item) => item.stopReason === "aborted" || (item.kind === "tool" && item.phase === "error")),
			"assembler should surface abort on a bubble or tool card",
		);
	});

	live("steer while a bash tool is running emits queue_update", async () => {
		await engine.session.request({ type: "new_session" });
		const prompt = "Use the bash tool to run sleep 8. After it finishes, reply with the single word: finished.";
		const mark = engine.session.mark();
		await engine.session.request({ type: "prompt", message: prompt });
		await engine.session.wait((frame) => frame.type === "tool_execution_start", LIVE_RPC_TIMEOUT_MS);
		await engine.session.request({
			type: "prompt",
			message: "Do not wait. Reply with only the word: steered",
			streamingBehavior: "steer",
		});
		const queue = await engine.session.wait((frame) => frame.type === "queue_update", LIVE_RPC_TIMEOUT_MS);
		assert.ok(Array.isArray(queue.steering));
		assert.ok(queue.steering.length > 0, `expected steering queue, got ${JSON.stringify(queue.steering)}`);
		const applied = AtomicSession.handleEvent(AtomicSession.createSession(), queue);
		assert.equal(applied.kind, "queue");
		assert.ok(applied.queue.steering.length >= 1);
		await waitForAgentEnd(engine.session);
		assert.ok(engine.session.since(mark).some((frame) => frame.type === "queue_update"));
	});

	live("list_sessions is not a command, which is the session-picker gap", async () => {
		const id = "gap-list-sessions";
		engine.session.send({ id, type: "list_sessions" });
		const response = await engine.session.wait((frame) => frame.type === "response" && frame.id === id, 10_000);
		assert.equal(response.success, false);
	});
});
