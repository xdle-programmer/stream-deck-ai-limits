import { worstStatus } from "../status.ts";
import type { StatusThresholds, UsageSnapshot, UsageWindow } from "../types.ts";
import { DEFAULT_THRESHOLDS } from "../types.ts";
import type { CodexRateLimitWindow, CodexUsageResponse } from "./codex-types.ts";

/**
 * Convert a raw Codex rate-limit window into the normalized {@link UsageWindow}.
 *
 * `used_percent` is already a 0..100 percentage (clamped + rounded). `reset_at` is a unix
 * timestamp in **seconds** → converted to an ISO string. Missing values become `null`.
 */
function normalizeWindow(window: CodexRateLimitWindow | null | undefined, now: Date): UsageWindow {
	const pct = window?.used_percent;
	const usedPercent =
		typeof pct === "number" && Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.round(pct))) : null;
	const resetMs = typeof window?.reset_at === "number" && Number.isFinite(window.reset_at)
		? window.reset_at * 1000
		: typeof window?.reset_after_seconds === "number" && Number.isFinite(window.reset_after_seconds)
			? now.getTime() + window.reset_after_seconds * 1000 : null;
	const resetDate = resetMs !== null ? new Date(resetMs) : null;
	const resetAt = resetDate && Number.isFinite(resetDate.getTime()) ? resetDate.toISOString() : null;
	return { usedPercent, resetAt };
}

/**
 * Normalize a raw Codex usage response into a provider-agnostic {@link UsageSnapshot}.
 *
 * Identify windows by duration: a weekly-only account may put its 7-day window in primary.
 * Legacy responses without duration retain the old slot mapping. Explicit unknown durations
 * are never mislabeled as 5-hour or weekly limits.
 */
export function normalizeCodexUsage(
	raw: CodexUsageResponse,
	thresholds: StatusThresholds = DEFAULT_THRESHOLDS,
	now: Date = new Date(),
): UsageSnapshot {
	const rateLimit = raw.rate_limit ?? undefined;
	const primary = rateLimit?.primary_window;
	const secondary = rateLimit?.secondary_window;
	const windows = [primary, secondary];
	const sessionWindow = windows.find((window) => window?.limit_window_seconds === 18_000)
		?? (primary?.limit_window_seconds == null ? primary : undefined);
	const weeklyWindow = windows.find((window) => window?.limit_window_seconds === 604_800)
		?? (secondary?.limit_window_seconds == null ? secondary : undefined);
	const session = normalizeWindow(sessionWindow, now);
	const weekly = normalizeWindow(weeklyWindow, now);

	return {
		provider: "codex",
		session,
		weekly,
		status: worstStatus(session, weekly, thresholds),
		updatedAt: now.toISOString(),
		stale: false,
		thresholds,
	};
}
