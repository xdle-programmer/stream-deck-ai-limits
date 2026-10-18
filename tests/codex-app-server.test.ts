import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { CodexAppServer, CodexRpcError } from "../src/providers/codex/codex-app-server.ts";

function fakeChild() {
	const child = Object.assign(new EventEmitter(), {
		stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
		kills: 0, kill() { this.kills++; return true; },
	});
	return child;
}

test("Codex transport initializes before requests, parses split replies and delivers notifications", async () => {
	const child = fakeChild(); const server = new CodexAppServer(child as unknown as ChildProcessWithoutNullStreams);
	const sent: { id?: number; method: string }[] = [];
	child.stdin.on("data", (data) => {
		const request = JSON.parse(String(data)); sent.push(request);
		if (request.id != null) {
			const reply = JSON.stringify({ id: request.id, result: { account: null } }) + "\n";
			child.stdout.write(reply.slice(0, 10)); child.stdout.write(reply.slice(10));
		}
	});
	await server.initialize();
	const result = await server.request("account/read", { refreshToken: false });
	assert.deepEqual(sent.map((r) => r.method), ["initialize", "initialized", "account/read"]);
	assert.deepEqual(result, { account: null });
	let notified = false;
	server.onNotification((method, params) => { if (method === "account/login/completed") notified = params.success === true; });
	child.stdout.write('{"method":"account/login/completed","params":{"success":true}}\n');
	assert.equal(notified, true);
	server.close(); assert.equal(child.kills, 1);
});

test("Codex transport rejects pending requests when the child exits and never returns stderr", async () => {
	const child = fakeChild(); const server = new CodexAppServer(child as unknown as ChildProcessWithoutNullStreams);
	const response = assert.rejects(server.request("account/read"), (e: unknown) => e instanceof Error && !e.message.includes("SECRET"));
	child.stderr.write("SECRET token in diagnostic output"); child.emit("exit", 1);
	await response;
	await assert.rejects(server.request("account/read"), /connection closed/);
});

test("a timed-out request kills the engine and rejects other pending requests", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const child = fakeChild(); const server = new CodexAppServer(child as unknown as ChildProcessWithoutNullStreams, 100);
	const first = assert.rejects(server.request("account/login/start"), /stopped responding/);
	const second = assert.rejects(server.request("account/read"), /stopped responding/);
	t.mock.timers.tick(100); await Promise.all([first, second]); assert.equal(child.kills, 1);
});

test("malformed and oversized protocol data close the child without exposing it", async () => {
	for (const data of ["SECRET invalid json\n", "x".repeat(2 * 1024 * 1024 + 1)]) {
		const child = fakeChild(); const server = new CodexAppServer(child as unknown as ChildProcessWithoutNullStreams);
		const failed = assert.rejects(server.request("account/read"), (e: unknown) => e instanceof Error && !e.message.includes("SECRET"));
		child.stdout.write(data); await failed; assert.equal(child.kills, 1);
	}
});

test("RPC errors remain typed for the session to sanitize; unsupported server requests are rejected", async () => {
	const child = fakeChild(); const server = new CodexAppServer(child as unknown as ChildProcessWithoutNullStreams);
	const sent: unknown[] = [];
	child.stdin.on("data", (data) => sent.push(JSON.parse(String(data))));
	const failed = assert.rejects(server.request("account/rateLimits/read"), (e: unknown) => e instanceof CodexRpcError && e.code === -32601);
	child.stdout.write('{"id":0,"error":{"code":-32601,"message":"Unknown method"}}\n');
	await failed;
	child.stdout.write('{"id":3,"method":"account/chatgptAuthTokens/refresh","params":{}}\n');
	assert.deepEqual(sent.at(-1), { id: 3, error: { code: -32601, message: "Unsupported method" } });
	server.close();
});
