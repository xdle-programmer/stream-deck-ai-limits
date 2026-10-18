import type { UsageProvider, UsageStatus } from "../providers/types.ts";

/**
 * Palette for the usage key, keyed by status. Kept separate from the renderer so the visual
 * theme can be tweaked in one place without touching layout logic.
 */
export interface Palette {
	/** Key background. */
	background: string;
	/** Primary text (labels, percentages). */
	text: string;
	/** Dimmed text (secondary labels, e.g. STALE marker). */
	textMuted: string;
	/** Empty portion of a progress bar / track. */
	track: string;
	/** Filled portion of a progress bar — the accent for the current status. */
	accent: string;
}

const TEXT = "#f2f2f7";
const TEXT_MUTED = "#8e8e93";
const TRACK = "#3a3a3c";

/** Status → accent (fill) color. */
const ACCENT: Record<UsageStatus, string> = {
	ok: "green", // green
	warning: "#ffd60a", // yellow
	critical: "#ff9f0a", // orange
	limited: "#ff453a", // red
	stale: "#2d2d2d", // muted gray (data shown but dimmed)
	auth_required: "#2d2d2d", // neutral gray
	rate_limited: "#ff9f0a", // orange (a softer alarm than hard error)
	error: "#ff453a", // red
};

export function paletteForStatus(status: UsageStatus): Palette {
	return {
		background: "#000000",
		text: status === "stale" ? TEXT_MUTED : TEXT,
		textMuted: TEXT_MUTED,
		track: TRACK,
		accent: ACCENT[status],
	};
}

/** Brand accent for the label and optional outline; backgrounds are always black. */
export function providerColors(provider: UsageProvider): { accent: string } {
	switch (provider) {
		case "codex":
			return { accent: "#6983ff" }; // teal
		case "copilot":
			return { accent: "#6e7681" }; // GitHub-neutral gray
		case "claude":
		default:
			return { accent: "#d97757" }; // Claude orange
	}
}
