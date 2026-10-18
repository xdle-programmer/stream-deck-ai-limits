import { authRequired, genericError, isUsageError, type UsageError } from "../../utils/errors.ts";
import { isExpired, readClaudeCredentials } from "./claude-credentials.ts";
import { refreshClaudeToken, type RefreshedTokens } from "./claude-oauth.ts";
import {
	DedicatedClaudeProfileStore, profileCredentials,
	type ClaudeProfileRecord, type ClaudeProfileStore,
} from "./claude-profile.ts";

export interface ClaudeSession {
	readonly generation?: number;
	/** rejectedToken requests recovery from a 401, adopting a concurrent rotation first. */
	getAccessToken(rejectedToken?: string): Promise<string>;
}

export class ManagedClaudeSession implements ClaudeSession {
	private queue: Promise<unknown> = Promise.resolve();
	private pending: { before: string; record: ClaudeProfileRecord } | null = null;
	private rejectedRefreshToken: string | null = null;
	private loginInProgress = false;
	private revision = 0;
	private readonly listeners = new Set<() => void>();
	private refreshFailure: { token: string; until: number; error: UsageError } | null = null;
	private lastRotation: { accessToken: string; at: number } | null = null;
	private readonly store: ClaudeProfileStore;
	private readonly refresh: typeof refreshClaudeToken;
	private readonly now: () => number;

	constructor(
		store: ClaudeProfileStore = new DedicatedClaudeProfileStore(),
		refresh: typeof refreshClaudeToken = refreshClaudeToken,
		now: () => number = Date.now,
	) { this.store = store; this.refresh = refresh; this.now = now; }

	get generation(): number { return this.revision; }
	get isLoggingIn(): boolean { return this.loginInProgress; }
	get needsReconnect(): boolean { return this.rejectedRefreshToken !== null; }
	onChange(listener: () => void): void { this.listeners.add(listener); }
	private changed(): void {
		this.revision++;
		for (const listener of this.listeners) listener();
	}

	getAccessToken(rejectedToken?: string): Promise<string> {
		if (this.loginInProgress) return Promise.reject(genericError("Claude sign-in is in progress. Complete it in the browser."));
		return this.exclusive(() => this.store.withLock(async () => {
			if (this.loginInProgress) throw genericError("Claude sign-in is in progress.");
			const record = await this.store.read();
			// A server may rotate successfully just before a Keychain write fails. Retry that
			// write, not the already-consumed refresh token. A newer login supersedes pending data.
			if (this.pending) {
				if (JSON.stringify(record.document) === this.pending.before) {
					await this.store.write(this.pending.record);
					record.document = this.pending.record.document;
				}
				this.pending = null;
			}
			const creds = profileCredentials(record);
			if (creds.refreshToken !== this.rejectedRefreshToken) this.rejectedRefreshToken = null;
			if (creds.accessToken && !isExpired(creds.expiresAt, undefined, this.now()) && creds.accessToken !== rejectedToken) {
				return creds.accessToken;
			}
			if (!creds.refreshToken || creds.refreshToken === this.rejectedRefreshToken ||
				(creds.refreshTokenExpiresAt != null && creds.refreshTokenExpiresAt <= this.now())) {
				throw authRequired("Claude's plugin login expired. Reconnect Claude in the key's settings.");
			}
			if (this.lastRotation && this.lastRotation.accessToken === rejectedToken && this.now() - this.lastRotation.at < 60_000) {
				this.rejectedRefreshToken = creds.refreshToken;
				throw authRequired("Claude rejected a newly renewed plugin login. Reconnect Claude in the key's settings.");
			}
			if (this.refreshFailure?.token === creds.refreshToken && this.now() < this.refreshFailure.until) {
				throw this.refreshFailure.error;
			}
			let tokens: RefreshedTokens;
			try { tokens = await this.refresh(creds.refreshToken, creds.clientId); }
			catch (err) {
				if (isUsageError(err)) {
					if (err.status === "auth_required") this.rejectedRefreshToken = creds.refreshToken;
					else this.refreshFailure = {
						token: creds.refreshToken, error: err,
						until: this.now() + (err.status === "rate_limited" ? Math.max(60_000, err.retryAfterMs ?? 300_000) : 5000),
					};
				}
				throw err;
			}
			const updated: ClaudeProfileRecord = {
				...record,
				document: { ...record.document, claudeAiOauth: {
					...record.document.claudeAiOauth,
					accessToken: tokens.accessToken,
					refreshToken: tokens.refreshToken ?? creds.refreshToken,
					expiresAt: tokens.expiresAt,
					...(tokens.refreshTokenExpiresAt !== undefined ? { refreshTokenExpiresAt: tokens.refreshTokenExpiresAt } : {}),
					...(tokens.scopes !== undefined ? { scopes: tokens.scopes } : {}),
				} },
			};
			this.pending = { before: JSON.stringify(record.document), record: updated };
			this.lastRotation = { accessToken: tokens.accessToken, at: this.now() };
			await this.store.write(updated);
			this.pending = null;
			this.rejectedRefreshToken = null;
			this.refreshFailure = null;
			return tokens.accessToken;
		}));
	}

	/** Hold the same lock for the whole official login, excluding background refreshes. */
	async login(run: () => Promise<void>): Promise<void> {
		if (this.loginInProgress) throw genericError("Claude sign-in is already in progress.");
		this.loginInProgress = true;
		this.changed();
		try {
			await this.exclusive(() => this.store.withLock(async () => {
				await run();
				this.pending = null;
				this.rejectedRefreshToken = null;
				this.refreshFailure = null;
				this.lastRotation = null;
			}), true);
		} finally { this.loginInProgress = false; this.changed(); }
	}

	private exclusive<T>(run: () => Promise<T>, allowLogin = false): Promise<T> {
		const task = this.queue.then(() => {
			if (this.loginInProgress && !allowLogin) throw genericError("Claude sign-in is in progress.");
			return run();
		});
		this.queue = task.catch(() => {});
		return task;
	}
}

/** One rotation owner for every Claude action, interval and threshold combination. */
export const managedClaudeSession = new ManagedClaudeSession();

export function claudeSessionForPath(customPath?: string): ClaudeSession {
	if (!customPath?.trim()) return managedClaudeSession;
	// Explicit files can belong to the user's normal CLI. Never rotate that shared session.
	return {
		async getAccessToken(rejectedToken) {
			const creds = await readClaudeCredentials(customPath);
			if (isExpired(creds.expiresAt) || creds.accessToken === rejectedToken) {
				throw authRequired("Custom Claude credentials are read-only. Renew them with their owner or clear the path and connect the plugin profile.");
			}
			return creds.accessToken;
		},
	};
}
