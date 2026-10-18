import test from "node:test";
import assert from "node:assert/strict";
import { ManagedCodexSession, codexLimitsToUsage, isCodexLoginUrl, type CodexLimitsReply } from "../src/providers/codex/codex-session.ts";
import { CodexRpcError, type CodexConnection, type NotificationHandler } from "../src/providers/codex/codex-app-server.ts";
import { CodexProvider } from "../src/providers/codex/codex-provider.ts";
import { UsageCache } from "../src/cache/ttl-cache.ts";
import { isUsageError } from "../src/utils/errors.ts";

const LIMITS: CodexLimitsReply = { rateLimits: { primary: { usedPercent: 24, windowDurationMins: 10080, resetsAt: 1780218629 } } };
class FakeServer implements CodexConnection {
	listeners = new Set<NotificationHandler>();
	calls: { method: string; params?: Record<string, unknown> }[] = [];
	connected = false;
	closed = false;
	handler?: (method: string, params?: Record<string, unknown>) => unknown;
	async request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
		this.calls.push({ method, params });
		if (this.handler) return await this.handler(method, params) as T;
		if (method === "account/read") return { account: this.connected ? { type: "chatgpt" } : null } as T;
		if (method === "account/rateLimits/read") return LIMITS as T;
		if (method === "account/login/start") return { type: "chatgpt", loginId: "login1", authUrl: "https://auth.openai.com/authorize?state=private" } as T;
		return {} as T;
	}
	onNotification(callback: NotificationHandler) { this.listeners.add(callback); return () => this.listeners.delete(callback); }
	notify(method: string, params: Record<string, unknown>) { for (const callback of this.listeners) callback(method, params); }
	close() { this.closed = true; this.notify("connection/closed", {}); }
	complete(success = true) { this.connected = success; this.notify("account/login/completed", { loginId: "login1", success, error: success ? null : "SECRET-SERVER-ERROR" }); }
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("Codex login uses the official browser flow and the same session for every key", async () => {
	const server = new FakeServer(); const session = new ManagedCodexSession(async () => server);
	assert.equal((await session.status()).state, "disconnected");
	let changes = 0; session.onChange(() => changes++);
	let browserOpens = 0;
	const task = session.login(async (url) => { browserOpens++; assert.ok(isCodexLoginUrl(url)); server.complete(); });
	assert.equal(task, session.login(async () => { assert.fail("duplicate browser"); }));
	assert.equal((await session.status()).state, "connecting");
	await assert.rejects(session.getUsage(), (e: unknown) => isUsageError(e) && e.status === "auth_required");
	await task;
	assert.equal(browserOpens, 1); assert.equal(changes, 2);
	assert.equal((await session.status()).state, "connected");
	const [first, second] = await Promise.all([session.getUsage(), session.getUsage()]);
	assert.equal(first, second);
	assert.equal(server.calls.filter((c) => c.method === "account/rateLimits/read").length, 1);
	assert.equal(first.rate_limit?.primary_window?.limit_window_seconds, 604800);
	assert.ok(server.calls.every((c) => c.method.startsWith("account/")));
});

test("Codex login survives completion arriving before the start response", async () => {
	const server = new FakeServer(); const session = new ManagedCodexSession(async () => server);
	server.handler = (method) => {
		if (method === "account/login/start") { server.complete(); return { type: "chatgpt", loginId: "login1", authUrl: "https://chatgpt.com/auth" }; }
		return { account: { type: "chatgpt" } };
	};
	await session.login(async () => {});
	assert.equal((await session.status()).state, "connected");
});

test("cancel stops login and releases the session for another attempt", async () => {
	const server = new FakeServer(); const session = new ManagedCodexSession(async () => server);
	const task = session.login(async () => {});
	const result = assert.rejects(task, /cancelled/);
	await flush(); await session.cancelLogin(); await result;
	assert.equal(session.isLoggingIn, false); assert.equal(server.closed, true);
	assert.ok(server.calls.some((c) => c.method === "account/login/cancel" && c.params?.loginId === "login1"));
	await session.login(async () => server.complete());
	assert.equal(session.isLoggingIn, false);
});

test("cancel before startup finishes never opens a browser", async () => {
	let ready!: (server: CodexConnection) => void;
	const session = new ManagedCodexSession(() => new Promise((resolve) => { ready = resolve; }));
	const server = new FakeServer();
	const task = session.login(async () => assert.fail("cancelled browser opened"));
	const result = assert.rejects(task, /cancelled/);
	await flush(); const cancel = session.cancelLogin(); ready(server);
	await cancel; await result; assert.equal(server.closed, true);
});

test("unexpected login URLs are rejected and the callback process is stopped", async () => {
	const server = new FakeServer(); const session = new ManagedCodexSession(async () => server);
	server.handler = () => ({ type: "chatgpt", loginId: "login1", authUrl: "https://example.com/steal" });
	await assert.rejects(session.login(async () => assert.fail("untrusted URL opened")), /unsupported login/);
	assert.equal(server.closed, true);
	for (const url of ["http://chatgpt.com/auth", "https://auth.openai.com.evil.com/", "https://user@chatgpt.com/", "file:///tmp/login", "https://chatgpt.com:8443/"]) assert.equal(isCodexLoginUrl(url), false);
});

test("Codex RPC errors and login notifications never leak raw error text", async () => {
	const server = new FakeServer(); const session = new ManagedCodexSession(async () => server);
	server.handler = () => { throw new CodexRpcError(-32000, "SECRET-TOKEN-AND-EMAIL"); };
	await assert.rejects(session.status(), (e: unknown) => isUsageError(e) && !e.message.includes("SECRET"));
	server.handler = undefined;
	await assert.rejects(session.login(async () => server.complete(false)), (e: unknown) => isUsageError(e) && !e.message.includes("SECRET"));
});

test("Codex refresh is delegated once to the engine after an auth failure, then retried", async () => {
	const server = new FakeServer(); const session = new ManagedCodexSession(async () => server);
	let reads = 0;
	server.handler = (method) => {
		if (method === "account/read") return { account: { type: "chatgpt" } };
		if (++reads === 1) throw new CodexRpcError(-32000, "HTTP 401 invalid access token SECRET");
		return LIMITS;
	};
	assert.ok((await session.getUsage()).rate_limit);
	assert.equal(reads, 2);
	assert.equal(server.calls.filter((c) => c.params?.refreshToken === true).length, 1);
});

test("rejected renewal requests reconnect; network/403 errors do not claim the login expired", async () => {
	for (const [message, expected] of [["401 refresh token revoked SECRET", "auth_required"], ["Your refresh token has already been used SECRET", "auth_required"], ["403 Forbidden SECRET", "error"], ["network unavailable SECRET", "error"], ["Failed to refresh token: network unavailable SECRET", "error"], ["429 Too many requests SECRET", "rate_limited"]] as const) {
		const server = new FakeServer(); const session = new ManagedCodexSession(async () => server);
		server.handler = (method) => {
			if (method === "account/read") return { account: { type: "chatgpt" } };
			throw new CodexRpcError(-32000, message);
		};
		await assert.rejects(session.getUsage(), (e: unknown) => isUsageError(e) && e.status === expected && !e.message.includes("SECRET"));
		assert.equal((await session.status()).state, expected === "auth_required" ? "disconnected" : "connected");
	}
});

test("a timed-out Codex login cancels its callback and allows another login", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const server = new FakeServer(); const session = new ManagedCodexSession(async () => server);
	const task = session.login(async () => {}); const failed = assert.rejects(task, /timed out/);
	await flush(); t.mock.timers.tick(10 * 60_000); await failed;
	assert.equal(server.closed, true); assert.equal(session.isLoggingIn, false);
});

test("an older status request cannot re-enable Connect while browser login is in progress", async () => {
	const server = new FakeServer(); const session = new ManagedCodexSession(async () => server);
	let finish!: (value: unknown) => void;
	server.handler = (method) => method === "account/read" ? new Promise((resolve) => { finish = resolve; })
		: { type: "chatgpt", loginId: "login1", authUrl: "https://chatgpt.com/auth" };
	const status = session.status(); await flush();
	const login = session.login(async () => {}); const failed = assert.rejects(login, /cancelled/);
	finish({ account: null }); assert.equal((await status).state, "connecting");
	await flush(); await session.cancelLogin(); await failed;
});

test("lost app-server during browser login settles the flow without waiting for the timeout", async () => {
	const server = new FakeServer(); const session = new ManagedCodexSession(async () => server);
	await assert.rejects(session.login(async () => server.close()), /sign-in/);
	assert.equal(session.isLoggingIn, false);
});

test("Codex chooses the main quota bucket and normalizes a weekly-only primary window", async () => {
	const raw = codexLimitsToUsage({ rateLimits: { limitId: "other", primary: { usedPercent: 99 } }, rateLimitsByLimitId: { codex: LIMITS.rateLimits! } });
	assert.equal(raw.rate_limit?.primary_window?.used_percent, 24);
	assert.throws(() => codexLimitsToUsage({ rateLimits: { limitId: "other" } }), /main limits/);
	const provider = new CodexProvider({ cache: new UsageCache({ provider: "codex" }), session: { generation: 0, getUsage: async () => raw } });
	const snapshot = await provider.getUsage();
	assert.equal(snapshot.session.usedPercent, null); assert.equal(snapshot.weekly.usedPercent, 24);
});

test("reconnecting invalidates cached usage and discards a previous account's in-flight reply", async () => {
	let finish!: (value: ReturnType<typeof codexLimitsToUsage>) => void;
	const session = { generation: 0, getUsage: () => new Promise<ReturnType<typeof codexLimitsToUsage>>((resolve) => { finish = resolve; }) };
	const provider = new CodexProvider({ cache: new UsageCache({ provider: "codex" }), session });
	const old = provider.getUsage();
	session.generation++;
	finish(codexLimitsToUsage(LIMITS));
	assert.equal((await old).status, "auth_required");
	const current = provider.getUsage(); finish(codexLimitsToUsage(LIMITS));
	assert.equal((await current).weekly.usedPercent, 24);
	session.generation++;
	const next = provider.getUsage(); finish(codexLimitsToUsage({ rateLimits: { primary: { usedPercent: 77, windowDurationMins: 10080 } } }));
	assert.equal((await next).weekly.usedPercent, 77);
});
