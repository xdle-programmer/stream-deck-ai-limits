import { genericError, rateLimited, UnauthorizedError } from "../../utils/errors.ts";
import { parseRetryAfterMs } from "../../utils/http.ts";
import type { CodexUsageResponse } from "./codex-types.ts";

/** Codex usage endpoint (ChatGPT backend). Unofficial — may change. */
const USAGE_ENDPOINT = "https://chatgpt.com/backend-api/codex/usage";

const REQUEST_TIMEOUT_MS = 8_000;

/**
 * Legacy HTTP path for explicitly selected credentials files. A CLI-style user agent alone
 * does not guarantee access: the edge can challenge Node's HTTP client with an HTML 403.
 */
function usageHeaders(accessToken: string, accountId: string | null): Headers {
	// IMPORTANT: build a `Headers` instance and use `.set()`. On Stream Deck's Node 24 runtime,
	// undici drops a `User-Agent` provided via a plain object literal (any casing) and sends its
	// own default UA instead → the Codex endpoint returns 403. Setting it on a `Headers` object
	// is the only form that actually transmits the custom UA. (Verified on Node 24.13.)
	const headers = new Headers();
	headers.set("authorization", `Bearer ${accessToken}`);
	headers.set("user-agent", "codex_cli_rs");
	headers.set("accept", "application/json");
	if (accountId) {
		headers.set("chatgpt-account-id", accountId);
	}
	return headers;
}

/**
 * Fetch the raw Codex usage response.
 *
 * @throws {UnauthorizedError} on HTTP 401 (custom credentials are read-only).
 * @throws {UsageError} `rate_limited` on 429, `error` on 403 or other failures.
 *
 * Never logs the access token or the Authorization header.
 */
export async function fetchCodexUsage(accessToken: string, accountId: string | null): Promise<CodexUsageResponse> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	let response: Response;
	try {
		response = await fetch(USAGE_ENDPOINT, {
			method: "GET",
			headers: usageHeaders(accessToken, accountId),
			signal: controller.signal,
		});
	} catch (err) {
		const aborted = (err as Error)?.name === "AbortError";
		throw genericError(aborted ? "Usage request timed out." : "Usage request network error.");
	} finally {
		clearTimeout(timer);
	}

	if (response.status === 401) {
		throw new UnauthorizedError();
	}
	if (response.status === 403) {
		throw genericError(response.headers.get("cf-mitigated") === "challenge"
			? "Codex's edge protection blocked this HTTP client. Clear Credentials path and use Connect Codex."
			: "Codex denied this request (HTTP 403). Check account/workspace access, or clear Credentials path and use Connect Codex.");
	}
	if (response.status === 429) {
		throw rateLimited("Codex usage rate limit reached.", parseRetryAfterMs(response.headers.get("retry-after")));
	}
	if (!response.ok) {
		throw genericError(`Codex usage request failed (HTTP ${response.status}).`);
	}

	try {
		return (await response.json()) as CodexUsageResponse;
	} catch {
		throw genericError("Codex usage response was not valid JSON.");
	}
}
