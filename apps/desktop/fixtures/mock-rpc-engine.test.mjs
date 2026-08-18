import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const dir = dirname(fileURLToPath(import.meta.url));
const enginePath = join(dir, "mock-rpc-engine.mjs");

function createClient(extraArgs = []) {
	const child = spawn(process.execPath, [enginePath, ...extraArgs], {
		stdio: ["pipe", "pipe", "pipe"],
	});
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
			const parsed = JSON.parse(frame.toString("utf8"));
			const waiter = waiters.shift();
			if (waiter) waiter(parsed);
			else frames.push(parsed);
		}
	}

	child.stdout.on("data", consume);

	function send(value) {
		child.stdin.write(`${JSON.stringify(value)}\n`);
	}

	function nextFrame(timeoutMs = 4000) {
		return new Promise((resolve, reject) => {
			if (frames.length) {
				resolve(frames.shift());
				return;
			}
			const timer = setTimeout(() => reject(new Error("timed out waiting for fixture frame")), timeoutMs);
			waiters.push((frame) => {
				clearTimeout(timer);
				resolve(frame);
			});
		});
	}

	async function nextMatching(predicate, timeoutMs = 4000) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const frame = await nextFrame(deadline - Date.now());
			if (predicate(frame)) return frame;
		}
		throw new Error("timed out waiting for matching fixture frame");
	}

	return { child, send, nextFrame, nextMatching };
}

test("fixture get_state returns a model and session id", async () => {
	const client = createClient();
	client.send({ id: "1", type: "get_state" });
	const frame = await client.nextMatching((event) => event.type === "response");
	client.child.kill();
	assert.equal(frame.success, true);
	assert.equal(frame.data.sessionId, "fixture-session");
	assert.equal(frame.data.model.id, "fixture/mock");
});

test("fixture streams pong as text deltas", async () => {
	const client = createClient(["--scenario", "stream"]);
	client.send({ id: "2", type: "prompt", message: "pong" });
	const deltas = [];
	while (true) {
		const frame = await client.nextFrame();
		if (frame.type === "message_update" && frame.assistantMessageEvent?.type === "text_delta") {
			deltas.push(frame.assistantMessageEvent.delta);
		}
		if (frame.type === "agent_settled") break;
	}
	client.child.kill();
	assert.equal(deltas.join(""), "pong");
});

test("fixture emits a bash tool card", async () => {
	const client = createClient(["--scenario", "tool"]);
	client.send({ id: "3", type: "prompt", message: "run pwd as a tool" });
	const types = [];
	while (true) {
		const frame = await client.nextFrame();
		types.push(frame.type);
		if (frame.type === "agent_settled") break;
	}
	client.child.kill();
	assert.ok(types.includes("tool_execution_start"));
	assert.ok(types.includes("tool_execution_end"));
});

test("fixture confirm waits for extension_ui_response", async () => {
	const client = createClient(["--scenario", "confirm"]);
	client.send({ id: "4", type: "prompt", message: "please confirm" });
	const request = await client.nextMatching((event) => event.type === "extension_ui_request");
	assert.equal(request.method, "confirm");
	client.send({ type: "extension_ui_response", id: request.id, confirmed: true });
	const end = await client.nextMatching((event) => event.type === "tool_execution_end");
	client.child.kill();
	assert.equal(end.toolName, "bash");
});

test("fixture abort cuts a slow stream", async () => {
	const client = createClient(["--scenario", "abort"]);
	client.send({ id: "5", type: "prompt", message: "slow abort please" });
	await client.nextMatching((event) => event.type === "message_update");
	client.send({ id: "6", type: "abort" });
	const ended = await client.nextMatching(
		(event) => event.type === "message_end" && event.message?.role === "assistant",
		6000,
	);
	client.child.kill();
	assert.equal(ended.message.stopReason, "aborted");
});

test("fixture requires streamingBehavior while a turn is running", async () => {
	const client = createClient(["--scenario", "abort"]);
	client.send({ id: "7", type: "prompt", message: "slow" });
	await client.nextMatching((event) => event.type === "agent_start");
	client.send({ id: "8", type: "prompt", message: "again" });
	const rejected = await client.nextMatching((event) => event.id === "8");
	client.send({ id: "9", type: "abort" });
	client.child.kill();
	assert.equal(rejected.success, false);
	assert.match(rejected.error, /streamingBehavior/);
});

test("fixture select waits for extension_ui_response", async () => {
	const client = createClient(["--scenario", "select"]);
	client.send({ id: "10", type: "prompt", message: "please choose" });
	const request = await client.nextMatching((event) => event.type === "extension_ui_request");
	assert.equal(request.method, "select");
	client.send({ type: "extension_ui_response", id: request.id, value: "Allow" });
	const end = await client.nextMatching((event) => event.type === "tool_execution_end");
	client.child.kill();
	assert.equal(end.toolName, "bash");
});

test("fixture queues steer while a turn is running", async () => {
	const client = createClient(["--scenario", "abort"]);
	client.send({ id: "11", type: "prompt", message: "slow" });
	await client.nextMatching((event) => event.type === "agent_start");
	client.send({ id: "12", type: "prompt", message: "stop and do this", streamingBehavior: "steer" });
	const queued = await client.nextMatching((event) => event.type === "queue_update");
	client.send({ id: "13", type: "abort" });
	client.child.kill();
	assert.deepEqual(queued.steering, ["stop and do this"]);
});
