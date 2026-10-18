import { UsageCache } from "../../cache/ttl-cache.ts";
import { authRequired } from "../../utils/errors.ts";
import { noopLogger, type SafeLogger } from "../../utils/logger.ts";
import type {
	GetUsageOptions,
	Provider,
	StatusThresholds,
	UsageSnapshot,
} from "../types.ts";
import { DEFAULT_THRESHOLDS } from "../types.ts";
import { fetchClaudeUsage, UnauthorizedError } from "./claude-api-client.ts";
import { normalizeClaudeUsage } from "./claude-normalizer.ts";
import { claudeSessionForPath, type ClaudeSession } from "./claude-session.ts";

/**
 * Injectable dependencies — real implementations by default, overridable in tests.
 */
export interface ClaudeProviderDeps {
	fetchUsage: (accessToken: string) => Promise<Awaited<ReturnType<typeof fetchClaudeUsage>>>;
	now: () => number;
}

const defaultDeps: ClaudeProviderDeps = {
	fetchUsage: fetchClaudeUsage,
	now: Date.now,
};

export interface ClaudeProviderOptions {
	cache: UsageCache;
	thresholds?: StatusThresholds;
	customCredentialsPath?: string;
	logger?: SafeLogger;
	/** Test seam: override pipeline dependencies. */
	deps?: Partial<ClaudeProviderDeps>;
	session?: ClaudeSession;
}

/**
 * Claude provider: assembles credentials → (refresh) → fetch → (401 refresh+retry) → normalize,
 * all behind the shared {@link UsageCache}. Always resolves to a {@link UsageSnapshot}.
 */
export class ClaudeProvider implements Provider {
	private readonly cache: UsageCache;
	private readonly thresholds: StatusThresholds;
	private readonly log: SafeLogger;
	private readonly deps: ClaudeProviderDeps;
	private readonly session: ClaudeSession;

	constructor(options: ClaudeProviderOptions) {
		this.cache = options.cache;
		this.thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
		this.log = options.logger ?? noopLogger;
		this.deps = { ...defaultDeps, ...options.deps };
		this.session = options.session ?? claudeSessionForPath(options.customCredentialsPath);
	}

	async getUsage(options: GetUsageOptions = {}): Promise<UsageSnapshot> {
		if (this.session.generation !== undefined) this.cache.useAccountGeneration(this.session.generation);
		const snapshot = await this.cache.get(() => this.runPipeline(), { force: options.force });
		this.log.info(`claude usage: status=${snapshot.status} stale=${snapshot.stale}`);
		return snapshot;
	}

	/**
	 * The fetch pipeline. May throw a {@link UsageError} (mapped to a snapshot by the cache).
	 * 401 is handled here: one token refresh + retry before giving up as `auth_required`.
	 */
	private async runPipeline(): Promise<UsageSnapshot> {
		const generation = this.session.generation;
		const accessToken = await this.session.getAccessToken();

		let raw;
		try {
			raw = await this.deps.fetchUsage(accessToken);
		} catch (err) {
			if (err instanceof UnauthorizedError) {
				// Token may have just gone stale → refresh once and retry exactly once.
				this.log.debug("claude usage 401; recovering session and retrying once");
				const refreshed = await this.session.getAccessToken(accessToken);
				try {
					raw = await this.deps.fetchUsage(refreshed);
				} catch (retryErr) {
					if (retryErr instanceof UnauthorizedError) {
						throw authRequired("Claude's plugin login was rejected. Reconnect Claude in the key's settings.");
					}
					throw retryErr;
				}
			} else {
				throw err;
			}
		}

		if (generation !== this.session.generation) throw authRequired("Claude login changed. Refresh the key.");
		return normalizeClaudeUsage(raw, this.thresholds, new Date(this.deps.now()));
	}
}

/**
 * Convenience factory wiring real dependencies and a fresh cache for one Claude action.
 */
export function createClaudeProvider(options: {
	ttlMs?: number;
	thresholds?: StatusThresholds;
	customCredentialsPath?: string;
	logger?: SafeLogger;
}): ClaudeProvider {
	const cache = new UsageCache({ provider: "claude", ttlMs: options.ttlMs });
	return new ClaudeProvider({
		cache,
		thresholds: options.thresholds,
		customCredentialsPath: options.customCredentialsPath,
		logger: options.logger,
	});
}
