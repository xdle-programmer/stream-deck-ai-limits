import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, stat, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ManagedClaudeSession, claudeSessionForPath } from "../src/providers/claude/claude-session.ts";
import { DedicatedClaudeProfileStore, claudeProfileService, type ClaudeProfileRecord, type ClaudeProfileStore } from "../src/providers/claude/claude-profile.ts";
import { authRequired, genericError, isUsageError, rateLimited } from "../src/utils/errors.ts";

const NOW = 2_000_000;
function initial(): ClaudeProfileRecord {
	return { source: "file", document: { extra: { preserved: true }, claudeAiOauth: {
		accessToken: "OLD", refreshToken: "R1", expiresAt: NOW - 1,
		refreshTokenExpiresAt: NOW + 10_000_000, scopes: ["user:profile"], clientId: "CLIENT", subscriptionType: "max",
	} } };
}
function memoryStore(record = initial()) {
	let saved = structuredClone(record);
	let writes = 0;
	const store: ClaudeProfileStore = {
		read: async () => structuredClone(saved),
		write: async (next) => { writes++; saved = structuredClone(next); },
		withLock: async (run) => run(),
	};
	return { store, saved: () => saved, writes: () => writes };
}
const rotated = { accessToken: "NEW", refreshToken: "R2", expiresAt: NOW + 100_000, refreshTokenExpiresAt: NOW + 20_000_000 };

test("rotation persists both tokens and expiry while preserving profile metadata", async () => {
	const memory = memoryStore();
	const session = new ManagedClaudeSession(memory.store, async (refresh, client) => {
		assert.equal(refresh, "R1"); assert.equal(client, "CLIENT"); return rotated;
	}, () => NOW);
	assert.equal(await session.getAccessToken(), "NEW");
	const oauth = memory.saved().document.claudeAiOauth;
	assert.deepEqual(oauth, { ...initial().document.claudeAiOauth, ...rotated });
	assert.deepEqual(memory.saved().document.extra, { preserved: true });
	// A new manager represents restarting the plugin. It must use the persisted rotation.
	const restarted = new ManagedClaudeSession(memory.store, async () => { throw Error("must not rotate again"); }, () => NOW);
	assert.equal(await restarted.getAccessToken(), "NEW");
});

test("parallel keys with different caches share one rotation", async () => {
	const memory = memoryStore(); let calls = 0;
	const session = new ManagedClaudeSession(memory.store, async () => {
		calls++; await new Promise((resolve) => setTimeout(resolve, 10)); return rotated;
	}, () => NOW);
	assert.deepEqual(await Promise.all(Array.from({ length: 12 }, () => session.getAccessToken())), Array(12).fill("NEW"));
	assert.equal(calls, 1); assert.equal(memory.writes(), 1);
});

test("parallel 401 recoveries adopt an already rotated access token", async () => {
	const record = initial(); record.document.claudeAiOauth.expiresAt = NOW + 100_000;
	const memory = memoryStore(record); let calls = 0;
	const session = new ManagedClaudeSession(memory.store, async () => { calls++; return rotated; }, () => NOW);
	assert.deepEqual(await Promise.all([session.getAccessToken("OLD"), session.getAccessToken("OLD")] ), ["NEW", "NEW"]);
	assert.equal(calls, 1);
});

test("failed secure write retries the pending rotation rather than reusing R1", async () => {
	const memory = memoryStore(); const write = memory.store.write; let attempts = 0; let rotations = 0;
	memory.store.write = async (record) => { if (++attempts === 1) throw genericError("Keychain locked"); await write(record); };
	const session = new ManagedClaudeSession(memory.store, async () => { rotations++; return rotated; }, () => NOW);
	await assert.rejects(() => session.getAccessToken(), /Keychain locked/);
	assert.equal(await session.getAccessToken(), "NEW");
	assert.equal(rotations, 1); assert.equal(attempts, 2);
});

test("a newer login supersedes an unsaved rotation", async () => {
	const memory = memoryStore(); const write = memory.store.write;
	memory.store.write = async () => { throw genericError("locked"); };
	const session = new ManagedClaudeSession(memory.store, async () => rotated, () => NOW);
	await assert.rejects(() => session.getAccessToken());
	memory.store.write = write;
	const other = initial(); Object.assign(other.document.claudeAiOauth, { accessToken: "OTHER_ACCOUNT", refreshToken: "OTHER_R", expiresAt: NOW + 100_000 });
	await write(other);
	assert.equal(await session.getAccessToken(), "OTHER_ACCOUNT");
	assert.equal(memory.saved().document.claudeAiOauth.refreshToken, "OTHER_R");
});

test("refresh without rotation preserves the existing refresh token and expiry", async () => {
	const memory = memoryStore();
	const session = new ManagedClaudeSession(memory.store, async () => ({ accessToken: "NEW", refreshToken: null, expiresAt: NOW + 100_000 }), () => NOW);
	await session.getAccessToken();
	assert.equal(memory.saved().document.claudeAiOauth.refreshToken, "R1");
	assert.equal(memory.saved().document.claudeAiOauth.refreshTokenExpiresAt, NOW + 10_000_000);
});

test("expired refresh login requests reconnect without attempting refresh", async () => {
	const record = initial(); record.document.claudeAiOauth.refreshTokenExpiresAt = NOW - 1;
	const memory = memoryStore(record);
	const session = new ManagedClaudeSession(memory.store, async () => { throw Error("must not call"); }, () => NOW);
	await assert.rejects(() => session.getAccessToken(), (err) => isUsageError(err) && err.status === "auth_required");
	assert.equal(memory.writes(), 0);
});

test("invalid_grant is remembered without clearing any persisted credentials", async () => {
	const memory = memoryStore(); let calls = 0;
	const session = new ManagedClaudeSession(memory.store, async () => { calls++; throw authRequired("reconnect"); }, () => NOW);
	await assert.rejects(() => session.getAccessToken());
	await assert.rejects(() => session.getAccessToken());
	assert.equal(calls, 1); assert.equal(memory.writes(), 0);
	assert.deepEqual(memory.saved(), initial());
});

test("network failure preserves credentials and can recover", async () => {
	const memory = memoryStore(); let calls = 0; let now = NOW;
	const session = new ManagedClaudeSession(memory.store, async () => { if (++calls === 1) throw genericError("offline"); return rotated; }, () => now);
	await assert.rejects(() => session.getAccessToken());
	assert.deepEqual(memory.saved(), initial());
	now += 6000;
	assert.equal(await session.getAccessToken(), "NEW");
});

test("parallel keys share refresh rate-limit backoff even with Retry-After zero", async () => {
	const memory = memoryStore(); let calls = 0;
	const session = new ManagedClaudeSession(memory.store, async () => { calls++; throw rateLimited("wait", 0); }, () => NOW);
	const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => session.getAccessToken()));
	assert.ok(outcomes.every((result) => result.status === "rejected"));
	assert.equal(calls, 1); assert.equal(memory.writes(), 0);
});

test("a 401 after proactive rotation never consumes the rotated refresh token immediately again", async () => {
	let calls = 0;
	const session = new ManagedClaudeSession(memoryStore().store, async () => { calls++; return rotated; }, () => NOW);
	assert.equal(await session.getAccessToken(), "NEW");
	await assert.rejects(() => session.getAccessToken("NEW"), (err) => isUsageError(err) && err.status === "auth_required");
	assert.equal(calls, 1);
});

test("official login pauses background renewal and duplicate login; resumes on completion", async () => {
	const memory = memoryStore(); let finish!: () => void;
	const session = new ManagedClaudeSession(memory.store, async () => rotated, () => NOW);
	const login = session.login(() => new Promise<void>((resolve) => { finish = resolve; }));
	await new Promise((resolve) => setImmediate(resolve));
	await assert.rejects(() => session.getAccessToken(), /sign-in is in progress/);
	await assert.rejects(() => session.login(async () => {}), /already in progress/);
	finish(); await login;
	assert.equal(session.generation, 2); assert.equal(session.isLoggingIn, false);
	assert.equal(await session.getAccessToken(), "NEW");
});

test("cancelled login resumes background work", async () => {
	const session = new ManagedClaudeSession(memoryStore().store, async () => rotated, () => NOW);
	await assert.rejects(() => session.login(async () => { throw genericError("cancelled"); }));
	assert.equal(session.isLoggingIn, false);
	assert.equal(await session.getAccessToken(), "NEW");
});

test("file-backed profile survives restart, writes atomically and restricts POSIX permissions", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "claude-profile-test-"));
	try {
		const store = new DedicatedClaudeProfileStore(dir, "linux");
		await store.write(initial());
		const session = new ManagedClaudeSession(store, async () => rotated, () => NOW);
		assert.equal(await session.getAccessToken(), "NEW");
		const restarted = new ManagedClaudeSession(new DedicatedClaudeProfileStore(dir, "linux"), async () => { throw Error("unnecessary refresh"); }, () => NOW);
		assert.equal(await restarted.getAccessToken(), "NEW");
		assert.equal(JSON.parse(await readFile(path.join(dir, ".credentials.json"), "utf-8")).claudeAiOauth.refreshToken, "R2");
		if (process.platform !== "win32") assert.equal((await stat(path.join(dir, ".credentials.json"))).mode & 0o777, 0o600);
		assert.deepEqual(await readdir(dir), [".credentials.json"]);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("separate store instances serialize rotations across processes' lock boundary", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "claude-lock-test-"));
	try {
		const first = new DedicatedClaudeProfileStore(dir, "linux"); await first.write(initial());
		let rotations = 0;
		const refresh = async () => { rotations++; await new Promise((resolve) => setTimeout(resolve, 20)); return rotated; };
		const sessions = [first, new DedicatedClaudeProfileStore(dir, "linux")].map((store) => new ManagedClaudeSession(store, refresh, () => NOW));
		assert.deepEqual(await Promise.all(sessions.map((session) => session.getAccessToken())), ["NEW", "NEW"]);
		assert.equal(rotations, 1);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("macOS profile uses its own Keychain service and prefers Keychain over stale fallback file", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "claude-keychain-test-"));
	try {
		await writeFile(path.join(dir, ".credentials.json"), "stale invalid file");
		let saved = JSON.stringify(initial().document); const services: string[] = [];
		const store = new DedicatedClaudeProfileStore(dir, "darwin", {
			read: async (service) => { services.push(service); return saved; },
			write: async (service, contents) => { services.push(service); saved = contents; },
		});
		assert.equal(await new ManagedClaudeSession(store, async () => rotated, () => NOW).getAccessToken(), "NEW");
		assert.ok(services.every((service) => service === claudeProfileService(dir)));
		assert.notEqual(services[0], "Claude Code-credentials");
		assert.equal(await readFile(path.join(dir, ".credentials.json"), "utf-8"), "stale invalid file");
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("explicit custom credentials are read-only, including when expired", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "claude-custom-test-"));
	const file = path.join(dir, ".credentials.json");
	try {
		const document = initial().document; document.claudeAiOauth.expiresAt = Date.now() + 100_000;
		const original = JSON.stringify(document); await writeFile(file, original);
		const session = claudeSessionForPath(file);
		assert.equal(await session.getAccessToken(), "OLD");
		await assert.rejects(() => session.getAccessToken("OLD"), /read-only/);
		assert.equal(await readFile(file, "utf-8"), original);
	} finally { await rm(dir, { recursive: true, force: true }); }
});
