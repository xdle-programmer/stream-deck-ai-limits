import { authRequired, genericError, rateLimited } from "../../utils/errors.ts";
import { parseRetryAfterMs } from "../../utils/http.ts";

/**
 * Public OAuth client id used by the official Claude Code CLI. This is not a secret — it is
 * embedded in the distributed `claude` binary and identifies the public client, not the user.
 */
const CLAUDE_CODE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

/** Claude OAuth token endpoint (same one the Claude Code CLI refreshes against). */
const TOKEN_ENDPOINT = "https://platform.claude.com/v1/oauth/token";

const REFRESH_TIMEOUT_MS = 8_000;

/**
 * Full refresh result, persisted by the session manager only in the plugin-owned profile.
 */
export interface RefreshedTokens {
	accessToken: string;
	/** A rotated refresh token, if the server returned one; otherwise `null`. */
	refreshToken: string | null;
	/** New expiry as epoch milliseconds, if derivable from `expires_in`; otherwise `null`. */
	expiresAt: number | null;
	refreshTokenExpiresAt?: number;
	scopes?: string[];
}

interface TokenResponse {
	access_token?: unknown;
	refresh_token?: unknown;
	expires_in?: unknown;
	refresh_token_expires_in?: unknown;
	scope?: unknown;
}

/**
 * Exchange a refresh token for a fresh access token.
 *
 * @throws {UsageError} `auth_required` if the refresh token is missing/rejected (the user must
 *   re-login via Claude Code), or `error` on network/timeout/unexpected-response. Messages and
 *   logs never include token material.
 */
export async function refreshClaudeToken(refreshToken: string | null, clientId = CLAUDE_CODE_CLIENT_ID): Promise<RefreshedTokens> {
	if (!refreshToken) {
		throw authRequired("No refresh token available. Log in with Claude Code again.");
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);

	let response: Response;
	try {
		response = await fetch(TOKEN_ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				grant_type: "refresh_token",
				refresh_token: refreshToken,
				client_id: clientId,
			}),
			signal: controller.signal,
		});
	} catch (err) {
		const aborted = (err as Error)?.name === "AbortError";
		throw genericError(aborted ? "Token refresh timed out." : "Token refresh network error.");
	} finally {
		clearTimeout(timer);
	}

	if (response.status === 429) {
		throw rateLimited("Claude token refresh was rate limited.", parseRetryAfterMs(response.headers.get("retry-after")));
	}
	if (response.status === 400 || response.status === 401 || response.status === 403) {
		let code: unknown;
		try {
			const error = await response.json() as { error?: string | { type?: string } };
			code = typeof error?.error === "string" ? error.error : error?.error?.type;
		} catch {}
		if (code === "invalid_grant") {
			throw authRequired("Claude's plugin login expired or was revoked. Reconnect Claude in the key's settings.");
		}
		// A forbidden request or invalid OAuth client is not evidence that credentials expired.
		throw genericError(`Claude token refresh was rejected (HTTP ${response.status}).`);
	}
	if (!response.ok) {
		throw genericError(`Token refresh failed (HTTP ${response.status}).`);
	}

	let body: TokenResponse;
	try {
		body = (await response.json()) as TokenResponse;
	} catch {
		throw genericError("Token refresh returned an unexpected response.");
	}

	const accessToken = typeof body?.access_token === "string" ? body.access_token : "";
	if (!accessToken) {
		throw genericError("Token refresh response had no access token.");
	}

	const expiresInSec = typeof body.expires_in === "number" && Number.isFinite(body.expires_in) && body.expires_in >= 0 ? body.expires_in : null;
	const refreshExpiresIn = typeof body.refresh_token_expires_in === "number" && Number.isFinite(body.refresh_token_expires_in) && body.refresh_token_expires_in >= 0 ? body.refresh_token_expires_in : null;
	return {
		accessToken,
		refreshToken: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : null,
		expiresAt: expiresInSec !== null ? Date.now() + expiresInSec * 1000 : null,
		...(refreshExpiresIn !== null ? { refreshTokenExpiresAt: Date.now() + refreshExpiresIn * 1000 } : {}),
		...(typeof body.scope === "string" ? { scopes: body.scope.split(" ").filter(Boolean) } : {}),
	};
}
