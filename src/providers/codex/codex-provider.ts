import { UsageCache } from "../../cache/ttl-cache.ts";
import { authRequired, UnauthorizedError } from "../../utils/errors.ts";
import { noopLogger, type SafeLogger } from "../../utils/logger.ts";
import type { GetUsageOptions, Provider, StatusThresholds, UsageSnapshot } from "../types.ts";
import { DEFAULT_THRESHOLDS } from "../types.ts";
import { fetchCodexUsage } from "./codex-api-client.ts";
import { readCodexCredentials, type CodexCredentials } from "./codex-credentials.ts";
import { normalizeCodexUsage } from "./codex-normalizer.ts";
import { managedCodexSession, type CodexUsageSession } from "./codex-session.ts";

/** Injectable dependencies — real implementations by default, overridable in tests. */
export interface CodexProviderDeps {
	readCredentials: (customPath?: string) => Promise<CodexCredentials>;
	fetchUsage: (accessToken: string, accountId: string | null) => Promise<Awaited<ReturnType<typeof fetchCodexUsage>>>;
	now: () => number;
}

const defaultDeps: CodexProviderDeps = {
	readCredentials: readCodexCredentials,
	fetchUsage: fetchCodexUsage,
	now: Date.now,
};

export interface CodexProviderOptions {
	cache: UsageCache;
	thresholds?: StatusThresholds;
	customCredentialsPath?: string;
	logger?: SafeLogger;
	deps?: Partial<CodexProviderDeps>;
	session?: CodexUsageSession;
}

/**
 * Default: official Codex app-server owns login, token renewal and limits. An explicit custom
 * credentials file keeps the legacy, read-only HTTP path without modifying its owner's login.
 */
export class CodexProvider implements Provider {
	private readonly cache: UsageCache;
	private readonly thresholds: StatusThresholds;
	private readonly customCredentialsPath?: string;
	private readonly log: SafeLogger;
	private readonly deps: CodexProviderDeps;
	private readonly session?: CodexUsageSession;

	constructor(options: CodexProviderOptions) {
		this.cache = options.cache;
		this.thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
		this.customCredentialsPath = options.customCredentialsPath;
		this.log = options.logger ?? noopLogger;
		this.deps = { ...defaultDeps, ...options.deps };
		this.session = options.session ?? (options.customCredentialsPath ? undefined : managedCodexSession);
	}

	async getUsage(options: GetUsageOptions = {}): Promise<UsageSnapshot> {
		if (this.session) this.cache.useAccountGeneration(this.session.generation);
		const snapshot = await this.cache.get(() => this.runPipeline(), { force: options.force });
		this.log.info(`codex usage: status=${snapshot.status} stale=${snapshot.stale}`);
		return snapshot;
	}

	private async runPipeline(): Promise<UsageSnapshot> {
		if (this.session) {
			const generation = this.session.generation;
			const raw = await this.session.getUsage();
			if (generation !== this.session.generation) throw authRequired("Codex login changed. Refresh the key.");
			return normalizeCodexUsage(raw, this.thresholds, new Date(this.deps.now()));
		}
		const creds = await this.deps.readCredentials(this.customCredentialsPath);

		let raw;
		try {
			raw = await this.deps.fetchUsage(creds.accessToken, creds.accountId);
		} catch (err) {
			if (err instanceof UnauthorizedError) {
				throw authRequired("Custom Codex credentials expired. Renew them with their owner, or clear Credentials path and use Connect Codex.");
			}
			throw err;
		}

		return normalizeCodexUsage(raw, this.thresholds, new Date(this.deps.now()));
	}
}

/** Convenience factory wiring real dependencies and a fresh cache for one Codex action. */
export function createCodexProvider(options: {
	ttlMs?: number;
	thresholds?: StatusThresholds;
	customCredentialsPath?: string;
	logger?: SafeLogger;
}): CodexProvider {
	const cache = new UsageCache({ provider: "codex", ttlMs: options.ttlMs });
	return new CodexProvider({
		cache,
		thresholds: options.thresholds,
		customCredentialsPath: options.customCredentialsPath,
		logger: options.logger,
	});
}
