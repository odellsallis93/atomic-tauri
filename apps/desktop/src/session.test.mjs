import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const dir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(dir, "session.js"), "utf8");
const sandbox = { globalThis: {} };
sandbox.globalThis = sandbox;
const context = createContext(sandbox);
runInContext(source, context);
const { AtomicSession } = sandbox;

function play(events) {
	const session = AtomicSession.createSession();
	const kinds = [];
	for (const event of events) kinds.push(AtomicSession.handleEvent(session, event).kind);
	return { session, kinds };
}

test("streams assistant deltas then commits message_end", () => {
	const { session } = play([
		{ type: "agent_start" },
		{ type: "message_start", message: { role: "user", content: "Reply with the single word: pong" } },
		{ type: "message_start", message: { role: "assistant", content: [], stopReason: "pending" } },
		{
			type: "message_update",
			assistantMessageEvent: { type: "text_start", contentIndex: 0 },
		},
		{
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "po" },
		},
		{
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ng" },
		},
		{
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "pong" }], stopReason: "stop" },
		},
		{ type: "agent_end" },
	]);
	assert.equal(session.items[0].kind, "user");
	assert.equal(session.items[1].kind, "assistant");
	assert.equal(session.items[1].text, "pong");
	assert.equal(session.items[1].streaming, false);
	assert.equal(session.streaming, false);
});

test("does not duplicate an optimistic local user message", () => {
	const session = AtomicSession.createSession();
	AtomicSession.noteLocalUser(session, "hello");
	AtomicSession.handleEvent(session, {
		type: "message_start",
		message: { role: "user", content: "hello" },
	});
	assert.equal(session.items.length, 1);
});

test("renders tool running and completed states", () => {
	const { session } = play([
		{ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "pwd" } },
		{
			type: "tool_execution_update",
			toolCallId: "c1",
			partialResult: { content: [{ type: "text", text: "/workspace" }] },
		},
		{
			type: "tool_execution_end",
			toolCallId: "c1",
			isError: false,
			result: { content: [{ type: "text", text: "/workspace\n" }] },
		},
	]);
	assert.equal(session.items[0].kind, "tool");
	assert.equal(session.items[0].phase, "done");
	assert.match(session.items[0].output, /\/workspace/);
});

test("marks an aborted assistant message", () => {
	const { session } = play([
		{ type: "agent_start" },
		{ type: "message_start", message: { role: "assistant", content: [], stopReason: "pending" } },
		{
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "tick " },
		},
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "tick " }],
				stopReason: "aborted",
				errorMessage: "Operation aborted",
			},
		},
		{ type: "agent_end" },
	]);
	assert.equal(session.items[0].stopReason, "aborted");
	assert.equal(session.items[0].errorMessage, "Operation aborted");
	assert.equal(session.streaming, false);
});

test("tracks steer and follow-up queues", () => {
	const { session, kinds } = play([
		{ type: "agent_start" },
		{ type: "queue_update", steering: ["stop"], followUp: ["then this"] },
	]);
	assert.equal(kinds.at(-1), "queue");
	assert.deepEqual([...session.queue.steering], ["stop"]);
	assert.deepEqual([...session.queue.followUp], ["then this"]);
});

test("surfaces extension and continue errors in the transcript", () => {
	const { session } = play([
		{ type: "extension_error", error: "boom" },
		{ type: "agent_continue_error", errorMessage: "could not continue" },
	]);
	assert.equal(session.items[0].kind, "error");
	assert.equal(session.items[1].text, "could not continue");
});

test("forwards extension UI requests to the host", () => {
	const session = AtomicSession.createSession();
	const result = AtomicSession.handleEvent(session, {
		type: "extension_ui_request",
		id: "ui-1",
		method: "confirm",
		title: "Allow?",
	});
	assert.equal(result.kind, "ui");
	assert.equal(result.request.id, "ui-1");
});
