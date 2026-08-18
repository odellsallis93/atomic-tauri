import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function loadAssembler() {
	const source = readFileSync(new URL("../src/session.js", import.meta.url), "utf8");
	new Function(source)();
	return globalThis.AtomicSession;
}

const AtomicSession = loadAssembler();

test("parseArgLines keeps paths with spaces as a single argument", () => {
	assert.deepEqual(AtomicSession.parseArgLines("--mode rpc\n--cwd\n/tmp/My Project\n\n"), [
		"--mode rpc",
		"--cwd",
		"/tmp/My Project",
	]);
	assert.equal(AtomicSession.formatArgLines(["--mode", "rpc"]), "--mode\nrpc");
});

test("applies documented message_update text deltas", () => {
	const session = AtomicSession.createSession();
	AtomicSession.handleEvent(session, {
		type: "message_start",
		message: { role: "assistant", content: [], stopReason: "pending" },
	});
	AtomicSession.handleEvent(session, {
		type: "message_update",
		assistantMessageEvent: { type: "text_start", contentIndex: 0 },
	});
	AtomicSession.handleEvent(session, {
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hel" },
	});
	AtomicSession.handleEvent(session, {
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" },
	});
	AtomicSession.handleEvent(session, {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "hello" }],
			stopReason: "stop",
		},
	});
	assert.equal(session.items.length, 1);
	assert.equal(session.items[0].text, "hello");
	assert.equal(session.items[0].streaming, false);
	assert.equal(session.items[0].stopReason, "stop");
});

test("records aborted stopReason on the assistant bubble", () => {
	const session = AtomicSession.createSession();
	AtomicSession.handleEvent(session, {
		type: "message_start",
		message: { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "pending" },
	});
	AtomicSession.handleEvent(session, {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "partial" }],
			stopReason: "aborted",
		},
	});
	assert.equal(session.items[0].stopReason, "aborted");
	assert.equal(session.items[0].text, "partial");
});

test("builds a tool card from tool_execution start/update/end", () => {
	const session = AtomicSession.createSession();
	AtomicSession.handleEvent(session, {
		type: "tool_execution_start",
		toolCallId: "call-1",
		toolName: "bash",
		args: { command: "pwd" },
	});
	AtomicSession.handleEvent(session, {
		type: "tool_execution_update",
		toolCallId: "call-1",
		args: { command: "pwd" },
		partialResult: { content: [{ type: "text", text: "/tmp" }] },
	});
	AtomicSession.handleEvent(session, {
		type: "tool_execution_end",
		toolCallId: "call-1",
		isError: false,
		result: { content: [{ type: "text", text: "/tmp/project" }] },
	});
	const tool = session.items[0];
	assert.equal(tool.kind, "tool");
	assert.equal(tool.toolName, "bash");
	assert.equal(tool.phase, "done");
	assert.deepEqual(tool.args, { command: "pwd" });
	assert.equal(tool.output, "/tmp/project");
});

test("queue_update is exposed as a queue hint, not a transcript card", () => {
	const session = AtomicSession.createSession();
	const result = AtomicSession.handleEvent(session, {
		type: "queue_update",
		steering: ["do this instead"],
		followUp: ["then summarize"],
	});
	assert.equal(result.kind, "queue");
	assert.deepEqual(result.queue.steering, ["do this instead"]);
	assert.equal(session.items.length, 0);
});

test("noteLocalUser suppresses the matching RPC user message", () => {
	const session = AtomicSession.createSession();
	AtomicSession.noteLocalUser(session, "hello");
	AtomicSession.handleEvent(session, {
		type: "message_start",
		message: { role: "user", content: "hello" },
	});
	assert.equal(session.items.filter((item) => item.kind === "user").length, 1);
	AtomicSession.handleEvent(session, {
		type: "message_end",
		message: { role: "user", content: "hello" },
	});
	assert.equal(session.items.filter((item) => item.kind === "user").length, 1);
});
