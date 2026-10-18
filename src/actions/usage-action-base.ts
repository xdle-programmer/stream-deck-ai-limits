import { SingletonAction } from "@elgato/streamdeck";
import type {
	DidReceiveSettingsEvent,
	KeyAction,
	KeyDownEvent,
	WillAppearEvent,
	WillDisappearEvent,
} from "@elgato/streamdeck";

import type { Provider, UsageProvider, UsageSnapshot } from "../providers/types.ts";
import { renderUsageIcon, toDataUrl } from "../render/usage-icon.ts";
import {
	resolveUsageSettings,
	resolveSingleWindowSettings,
	sameResolvedSettings,
	type ResolvedSingleWindowSettings,
	type ResolvedUsageSettings,
	type UsageActionSettings,
} from "../settings/usage-settings.ts";
import { logger } from "../utils/logger.ts";
import { managedClaudeSession } from "../providers/claude/claude-session.ts";
import { managedCodexSession } from "../providers/codex/codex-session.ts";

/** Builds a fresh {@link Provider} for one key from its resolved settings. */
export type ProviderFactory = (config: ResolvedUsageSettings) => Provider;

interface KeyRuntime {
	action: KeyAction;
	provider: Provider;
	config: ResolvedUsageSettings;
	displayConfig: ResolvedSingleWindowSettings;
	lastSnapshot: UsageSnapshot | null;
	refreshSequence: number;
	timer: ReturnType<typeof setInterval>;
	tickTimer: ReturnType<typeof setInterval>;
}

/**
 * Shared lifecycle for a provider-specific usage key (Claude, Codex or Copilot).
 *
 * Each visible key selects one limit and has a provider backed by a shared usage cache. Data
 * polling respects the configured interval; a separate display timer updates the countdown.
 * Property Inspector changes apply live, without a restart. Subclasses only supply the provider
 * id (for empty-state rendering/logging) and a factory.
 */
export abstract class UsageActionBase extends SingletonAction<UsageActionSettings> {
	private readonly instances = new Map<string, KeyRuntime>();

	constructor() {
		super();
		const onAuthChange = (provider: UsageProvider) => {
			if (this.providerId !== provider) return;
			for (const runtime of this.instances.values()) {
				if (!runtime.config.customCredentialsPath) {
					runtime.lastSnapshot = null;
					void this.refresh(runtime, { force: false });
				}
			}
		};
		managedClaudeSession.onChange(() => onAuthChange("claude"));
		managedCodexSession.onChange(() => onAuthChange("codex"));
	}

	protected abstract readonly providerId: UsageProvider;
	protected abstract createProvider(config: ResolvedUsageSettings): Provider;

	override async onWillAppear(ev: WillAppearEvent<UsageActionSettings>): Promise<void> {
		if (!ev.action.isKey()) {
			return;
		}
		const runtime = this.ensureRuntime(ev.action, ev.payload.settings);
		await this.refresh(runtime, { force: false });
		this.startTimer(runtime);
	}

	override onWillDisappear(ev: WillDisappearEvent<UsageActionSettings>): void {
		const runtime = this.instances.get(ev.action.id);
		if (runtime) {
			clearInterval(runtime.timer);
			clearInterval(runtime.tickTimer);
			this.instances.delete(ev.action.id);
		}
	}

	override async onKeyDown(ev: KeyDownEvent<UsageActionSettings>): Promise<void> {
		if (!ev.action.isKey()) {
			return;
		}
		const runtime = this.ensureRuntime(ev.action, ev.payload.settings);
		await this.refresh(runtime, { force: true });
	}

	/** Apply Property Inspector changes live: rebuild config, refresh, restart the timer. */
	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<UsageActionSettings>): Promise<void> {
		if (!ev.action.isKey()) {
			return;
		}
		const runtime = this.ensureRuntime(ev.action, ev.payload.settings);
		this.startTimer(runtime);
		await this.refresh(runtime, { force: false });
	}

	private ensureRuntime(keyAction: KeyAction, rawSettings: UsageActionSettings): KeyRuntime {
		const resolved = resolveUsageSettings(rawSettings);
		const displayConfig = resolveSingleWindowSettings({ ...rawSettings, provider: this.providerId });
		const existing = this.instances.get(keyAction.id);

		// Rebuild the provider only if config that affects fetching changed (or first appearance).
		if (!existing || !sameResolvedSettings(existing.config, resolved)) {
			if (existing) {
				clearInterval(existing.timer);
				clearInterval(existing.tickTimer);
			}
			const runtime: KeyRuntime = {
				action: keyAction,
				provider: this.createProvider(resolved),
				config: resolved,
				displayConfig,
				lastSnapshot: null,
				refreshSequence: 0,
				timer: undefined as unknown as ReturnType<typeof setInterval>,
				tickTimer: undefined as unknown as ReturnType<typeof setInterval>,
			};
			this.instances.set(keyAction.id, runtime);
			return runtime;
		}

		existing.action = keyAction; // keep the live action reference fresh
		existing.displayConfig = displayConfig;
		return existing;
	}

	private startTimer(runtime: KeyRuntime): void {
		if (this.instances.get(runtime.action.id) !== runtime) return;
		clearInterval(runtime.timer);
		clearInterval(runtime.tickTimer);
		runtime.timer = setInterval(() => {
			void this.refresh(runtime, { force: false });
		}, runtime.config.intervalSec * 1000);
		// Display-only redraw: the countdown must keep ticking even at a long polling interval.
		runtime.tickTimer = setInterval(() => {
			if (runtime.lastSnapshot) void this.draw(runtime, runtime.lastSnapshot);
		}, 60_000);
	}

	private async refresh(runtime: KeyRuntime, options: { force: boolean }): Promise<void> {
		const sequence = ++runtime.refreshSequence;
		let snapshot: UsageSnapshot;
		try {
			snapshot = await runtime.provider.getUsage({ force: options.force });
		} catch (err) {
			// Providers are designed never to throw, but guard the UI regardless.
			logger.error(`${this.providerId} usage unexpected failure: ${(err as Error)?.name ?? "Error"}`);
			snapshot = {
				provider: this.providerId,
				session: { usedPercent: null, resetAt: null },
				weekly: { usedPercent: null, resetAt: null },
				status: "error",
				updatedAt: new Date().toISOString(),
				stale: false,
			};
		}
		if (this.instances.get(runtime.action.id) !== runtime || sequence !== runtime.refreshSequence) return;
		runtime.lastSnapshot = snapshot;
		await this.draw(runtime, snapshot);
	}

	private async draw(runtime: KeyRuntime, snapshot: UsageSnapshot): Promise<void> {
		if (this.instances.get(runtime.action.id) !== runtime) return;
		await runtime.action.setImage(toDataUrl(renderUsageIcon(snapshot, new Date(), runtime.displayConfig)));
	}
}
