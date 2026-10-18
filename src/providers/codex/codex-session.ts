import { authRequired, genericError, isUsageError, rateLimited } from "../../utils/errors.ts";
import { CodexRpcError, startCodexAppServer, type CodexConnection } from "./codex-app-server.ts";
import type { CodexRateLimitWindow, CodexUsageResponse } from "./codex-types.ts";

interface AccountReply { account: { type: string } | null }
interface LimitWindow { usedPercent?: number | null; windowDurationMins?: number | null; resetsAt?: number | null }
interface Limits { primary?: LimitWindow | null; secondary?: LimitWindow | null; limitId?: string | null; planType?: string | null }
export interface CodexLimitsReply { rateLimits?: Limits; rateLimitsByLimitId?: Record<string, Limits> | null }
export interface CodexUsageSession {
	readonly generation: number;
	getUsage(): Promise<CodexUsageResponse>;
}
export interface CodexAuthStatus { state: "connected" | "disconnected" | "connecting"; message: string }
interface LoginCompletion { loginId: string; success: boolean }

/** Only official HTTPS login URLs can be opened; never accept browser URLs from the inspector. */
export function isCodexLoginUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443")
			&& ["auth.openai.com", "auth0.openai.com", "chatgpt.com"].includes(url.hostname);
	} catch { return false; }
}

/** Owns one official engine and one isolated login for every Codex key. No tokens leave it. */
export class ManagedCodexSession implements CodexUsageSession {
	generation = 0;
	private readonly connect: () => Promise<CodexConnection>;
	private connection: Promise<CodexConnection> | undefined;
	private usage: Promise<CodexUsageResponse> | undefined;
	private loginTask: Promise<void> | undefined;
	private completion: ((result: LoginCompletion) => void) | undefined;
	private loginId: string | undefined;
	private loginCancelled = false;
	private needsReconnect = false;
	private readonly listeners = new Set<() => void>();

	constructor(connect: () => Promise<CodexConnection> = startCodexAppServer) { this.connect = connect; }
	get isLoggingIn(): boolean { return this.loginTask !== undefined; }
	onChange(callback: () => void): () => void { this.listeners.add(callback); return () => this.listeners.delete(callback); }
	private changed(): void { this.generation++; this.usage = undefined; for (const callback of this.listeners) callback(); }

	private server(): Promise<CodexConnection> {
		if (!this.connection) {
			const task = this.connect().then((server) => {
				server.onNotification((method, params) => {
					if (method === "account/login/completed" && typeof params.loginId === "string") {
						this.completion?.({ loginId: params.loginId, success: params.success === true });
					} else if (method === "connection/closed") {
						if (this.connection === task) this.connection = undefined;
						this.completion?.({ loginId: this.loginId ?? "", success: false });
					}
				});
				return server;
			});
			this.connection = task;
			void task.catch(() => { if (this.connection === task) this.connection = undefined; });
		}
		return this.connection;
	}

	async status(): Promise<CodexAuthStatus> {
		if (this.isLoggingIn) return { state: "connecting", message: "Complete Codex sign-in in your browser. You can cancel and retry if needed." };
		if (this.needsReconnect) return { state: "disconnected", message: "Codex login was rejected. Click Connect Codex to sign in again." };
		try {
			const result = await (await this.server()).request<AccountReply>("account/read", { refreshToken: false });
			if (this.isLoggingIn) return { state: "connecting", message: "Complete Codex sign-in in your browser. You can cancel and retry if needed." };
			return result?.account?.type === "chatgpt"
				? { state: "connected", message: "Codex login saved. Codex automatically renews the plugin's separate session." }
				: { state: "disconnected", message: "Click Connect Codex and sign in with the ChatGPT account whose limits you want to display." };
		} catch (error) { throw safeCodexError(error); }
	}

	getUsage(): Promise<CodexUsageResponse> {
		if (this.isLoggingIn) return Promise.reject(authRequired("Complete Codex sign-in in your browser."));
		if (this.needsReconnect) return Promise.reject(authRequired("Reconnect Codex in the key's settings."));
		if (!this.usage) {
			const task = this.readUsage();
			this.usage = task;
			void task.finally(() => { if (this.usage === task) this.usage = undefined; }).catch(() => {});
		}
		return this.usage;
	}

	private async readUsage(): Promise<CodexUsageResponse> {
		const generation = this.generation;
		try {
			const server = await this.server();
			const account = await server.request<AccountReply>("account/read", { refreshToken: false });
			if (account?.account?.type !== "chatgpt") throw authRequired("Connect Codex in the key's settings using your ChatGPT account.");
			let reply: CodexLimitsReply;
			try { reply = await server.request<CodexLimitsReply>("account/rateLimits/read"); }
			catch (error) {
				if (!isAuthFailure(error)) throw error;
				// One recovery attempt through Codex itself, which saves the complete rotated tokens.
				await server.request("account/read", { refreshToken: true });
				reply = await server.request<CodexLimitsReply>("account/rateLimits/read");
			}
			if (generation !== this.generation) throw authRequired("Codex login changed. Refresh the key.");
			return codexLimitsToUsage(reply);
		} catch (error) {
			if (generation === this.generation && isAuthFailure(error)) this.needsReconnect = true;
			throw safeCodexError(error);
		}
	}

	login(openUrl: (url: string) => Promise<void>): Promise<void> {
		if (this.loginTask) return this.loginTask;
		this.loginCancelled = false;
		// Assign the promise before notifying keys, so polling pauses immediately.
		const task = Promise.resolve().then(() => this.runLogin(openUrl));
		this.loginTask = task;
		this.changed();
		void task.finally(() => {
			if (this.loginTask === task) this.loginTask = undefined;
			this.completion = undefined;
			this.loginId = undefined;
			this.changed();
		}).catch(() => {});
		return task;
	}

	private async runLogin(openUrl: (url: string) => Promise<void>): Promise<void> {
		let server: CodexConnection | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			server = await this.server();
			let finish!: (value: LoginCompletion) => void;
			const completed = new Promise<LoginCompletion>((resolve) => { finish = resolve; });
			this.completion = finish;
			const result = await server.request<{ type: string; loginId: string; authUrl: string }>("account/login/start", { type: "chatgpt" });
			this.loginId = result?.loginId;
			if (this.loginCancelled) throw genericError("Codex sign-in cancelled. Click Connect Codex to try again.");
			if (result?.type !== "chatgpt" || typeof result.loginId !== "string" || typeof result.authUrl !== "string" || !isCodexLoginUrl(result.authUrl)) {
				throw genericError("Codex returned an unsupported login response. Update Codex and retry.");
			}
			timer = setTimeout(() => finish({ loginId: result.loginId, success: false }), 10 * 60_000);
			try { await openUrl(result.authUrl); }
			catch { throw genericError("Could not open Codex sign-in in the browser. Check your default browser and reconnect Codex."); }
			const outcome = await completed;
			if (!outcome.success || outcome.loginId !== result.loginId || this.loginCancelled) throw genericError("Codex sign-in was cancelled, timed out or failed. Click Connect Codex to try again.");
			const account = await server.request<AccountReply>("account/read", { refreshToken: false });
			if (account?.account?.type !== "chatgpt") throw authRequired("Codex did not save a ChatGPT login. Reconnect Codex.");
			this.needsReconnect = false;
		} catch (error) {
			if (server && this.loginId) await server.request("account/login/cancel", { loginId: this.loginId }).catch(() => {});
			// Closing also removes the OAuth callback listener if cancellation was unsupported.
			server?.close();
			this.connection = undefined;
			throw safeCodexError(error);
		} finally { if (timer) clearTimeout(timer); }
	}

	async cancelLogin(): Promise<void> {
		if (!this.isLoggingIn) return;
		this.loginCancelled = true;
		this.completion?.({ loginId: this.loginId ?? "", success: false });
		await this.loginTask?.catch(() => {});
	}
}

function isAuthFailure(error: unknown): boolean {
	return error instanceof CodexRpcError && /\b401\b|unauthori[sz]ed|not (?:logged|authenticated)|invalid_grant|authentication.required|(?:refresh|access)[ _-]token.{0,100}(?:expir|revok|invalid|reused|already.{0,15}used|no longer valid)|(?:invalid|expired|revoked)[ _-](?:refresh|access)[ _-]token/i.test(error.message);
}

function safeCodexError(error: unknown): Error {
	if (isUsageError(error)) return error;
	if (isAuthFailure(error)) return authRequired("Codex could not renew the login. Reconnect Codex in the key's settings.");
	if (error instanceof CodexRpcError && /\b429\b|too many requests/i.test(error.message)) return rateLimited("Codex is temporarily rate-limited. Wait before retrying.");
	if (error instanceof CodexRpcError && error.code === -32601) return genericError("This Codex version does not support account login/limits. Update Codex and reconnect.");
	return genericError("Could not reach Codex. Check your connection, update Codex if needed, then retry.");
}

/** Keep period detection in one normalizer; multi-bucket replies must select the Codex bucket. */
export function codexLimitsToUsage(reply: CodexLimitsReply): CodexUsageResponse {
	const limits = reply?.rateLimitsByLimitId?.codex ?? reply?.rateLimits;
	if (!limits || (limits.limitId != null && limits.limitId !== "codex")) throw genericError("Codex did not return the account's main limits.");
	const window = (value: LimitWindow | null | undefined): CodexRateLimitWindow | null => value ? {
		used_percent: value.usedPercent,
		limit_window_seconds: typeof value.windowDurationMins === "number" ? value.windowDurationMins * 60 : null,
		reset_at: value.resetsAt,
	} : null;
	return { plan_type: limits.planType, rate_limit: { primary_window: window(limits.primary), secondary_window: window(limits.secondary) } };
}

export const managedCodexSession = new ManagedCodexSession();
