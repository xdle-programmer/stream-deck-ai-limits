import { statusForPercent } from "../providers/status.ts";
import { DEFAULT_THRESHOLDS, type UsageSnapshot, type UsageWindow } from "../providers/types.ts";
import type { ProviderAccent, WindowKind } from "../settings/usage-settings.ts";
import { formatCountdown } from "../utils/time.ts";
import { paletteForStatus, providerColors } from "./colors.ts";
import { SIZE, escapeXml } from "./svg.ts";

export { toDataUrl } from "./svg.ts";

export interface UsageIconOptions {
	window?: WindowKind;
	providerAccent?: ProviderAccent;
}

/** Every action uses one window, one percentage/bar and one compact reset countdown. */
export function renderUsageIcon(
	snapshot: UsageSnapshot,
	now: Date = new Date(),
	options: UsageIconOptions = {},
): string {
	const selected = selectUsageWindow(snapshot, options.window ?? "auto");
	const providerLabel = { claude: "Claude", codex: "Codex", copilot: "Copilot" }[snapshot.provider];
	const title = `${providerLabel} ${selected.label}`.trim();
	const palette = paletteForStatus("ok");
	const brand = providerColors(snapshot.provider).accent;
	const failure = snapshot.status === "auth_required" ? "Login Required"
		: snapshot.status === "rate_limited" ? "Rate Limited"
		: snapshot.status === "error" ? "Error"
		: selected.window.usedPercent === null ? "No Data" : null;

	let body: string;
	if (failure) {
		body = `<text x="72" y="83" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="17" font-weight="700" fill="${palette.text}">${escapeXml(failure)}</text>`;
	} else {
		const percent = Math.max(0, Math.min(100, Math.round(selected.window.usedPercent!)));
		const accent = paletteForStatus(statusForPercent(percent, snapshot.thresholds ?? DEFAULT_THRESHOLDS)).accent;
		const countdown = formatCountdown(selected.window.resetAt, now) ?? "—";
		const countdownSize = Math.min(28, Math.floor(122 / (countdown.length * 0.62)));
		body = `
  <text x="72" y="65" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="34" font-weight="800" fill="${accent}">${percent}%</text>
  <rect x="12" y="80" width="120" height="12" rx="6" fill="${palette.track}"/>
  ${percent > 0 ? `<rect x="12" y="80" width="${120 * percent / 100}" height="12" rx="6" fill="${accent}"/>` : ""}
  <text x="72" y="126" text-anchor="middle" font-family="Menlo, Consolas, monospace" font-size="${countdownSize}" font-weight="700" fill="${palette.text}">${escapeXml(countdown)}</text>`;
	}
	const staleDot = snapshot.stale && !failure
		? `<circle cx="133" cy="11" r="3" fill="${palette.textMuted}"><title>data is stale (refresh pending)</title></circle>` : "";
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <rect width="${SIZE}" height="${SIZE}" fill="#000000"/>
  <text x="72" y="27" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="16" font-weight="700" fill="${brand}">${escapeXml(title)}</text>
  ${body}
  ${staleDot}
</svg>`;
}

export function selectUsageWindow(snapshot: UsageSnapshot, requested: WindowKind): { window: UsageWindow; label: string } {
	if (snapshot.provider === "copilot") return { window: snapshot.session, label: "MO" };
	let kind = requested;
	if (kind === "auto") {
		if (snapshot.session.usedPercent !== null) kind = "session";
		else if (snapshot.weekly.usedPercent !== null) kind = "weekly";
		else return { window: snapshot.session, label: "" };
	}
	if (kind === "weekly") return { window: snapshot.weekly, label: "7D" };
	if (kind === "fable") return { window: snapshot.fable ?? { usedPercent: null, resetAt: null }, label: "FABLE" };
	return { window: snapshot.session, label: "5H" };
}
