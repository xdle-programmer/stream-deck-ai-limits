import test from "node:test";
import assert from "node:assert/strict";
import { refreshClaudeToken } from "../src/providers/claude/claude-oauth.ts";
import { isUsageError } from "../src/utils/errors.ts";

async function withResponse(status: number, body: unknown, run: () => Promise<void>, retryAfter?: string) {
	const original = globalThis.fetch;
	globalThis.fetch = async (_url, init) => {
		assert.deepEqual(JSON.parse(init!.body as string), { grant_type: "refresh_token", refresh_token: "R1", client_id: "PROFILE_CLIENT" });
		return new Response(JSON.stringify(body), { status, headers: retryAfter ? { "Retry-After": retryAfter } : {} });
	};
	try { await run(); } finally { globalThis.fetch = original; }
}

test("OAuth refresh parses the full rotation including both expirations and scope", async () => {
	const before = Date.now();
	await withResponse(200, { access_token: "A2", refresh_token: "R2", expires_in: 3600, refresh_token_expires_in: 86400, scope: "user:profile user:inference" }, async () => {
		const result = await refreshClaudeToken("R1", "PROFILE_CLIENT");
		assert.equal(result.accessToken, "A2"); assert.equal(result.refreshToken, "R2");
		assert.ok(result.expiresAt! >= before + 3_600_000);
		assert.ok(result.refreshTokenExpiresAt! >= before + 86_400_000);
		assert.deepEqual(result.scopes, ["user:profile", "user:inference"]);
	});
});

test("only confirmed invalid_grant requires a new login, never leaking response material", async () => {
	await withResponse(400, { error: "invalid_grant", error_description: "SECRET_CANARY" }, async () => {
		await assert.rejects(() => refreshClaudeToken("R1", "PROFILE_CLIENT"), (err) => {
			assert.ok(isUsageError(err)); assert.equal(err.status, "auth_required");
			assert.doesNotMatch(err.message, /SECRET_CANARY|R1/); return true;
		});
	});
});

for (const status of [400, 401, 403, 500]) {
	test(`refresh HTTP ${status} without invalid_grant is recoverable and preserves credentials`, async () => {
		await withResponse(status, { error: "temporary_or_configuration_error", message: "SECRET_CANARY" }, async () => {
			await assert.rejects(() => refreshClaudeToken("R1", "PROFILE_CLIENT"), (err) => isUsageError(err) && err.status === "error" && !err.message.includes("SECRET_CANARY"));
		});
	});
}

test("refresh 429 carries server backoff", async () => {
	await withResponse(429, {}, async () => {
		await assert.rejects(() => refreshClaudeToken("R1", "PROFILE_CLIENT"), (err) => isUsageError(err) && err.status === "rate_limited" && err.retryAfterMs === 90_000);
	}, "90");
});

test("unexpected refresh body is a sanitized error", async () => {
	await withResponse(200, null, async () => {
		await assert.rejects(() => refreshClaudeToken("R1", "PROFILE_CLIENT"), (err) => isUsageError(err) && err.status === "error");
	});
});
