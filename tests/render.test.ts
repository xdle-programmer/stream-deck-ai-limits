import test from "node:test";
import assert from "node:assert/strict";
import { renderUsageIcon, toDataUrl } from "../src/render/usage-icon.ts";
import type { UsageSnapshot, UsageStatus } from "../src/providers/types.ts";

const NOW = new Date("2026-05-31T00:00:00Z");
function snapshot(partial: Partial<UsageSnapshot> = {}): UsageSnapshot {
	return {
		provider: "claude", session: { usedPercent: 73, resetAt: "2026-05-31T04:10:00Z" },
		weekly: { usedPercent: 44, resetAt: "2026-06-03T05:00:00Z" },
		status: "warning", updatedAt: NOW.toISOString(), stale: false, ...partial,
	};
}

test("one selected 5-hour limit and countdown replace the two-window layout", () => {
	const svg = renderUsageIcon(snapshot(), NOW, { window: "session" });
	assert.match(svg, />Claude 5H</); assert.match(svg, />73%</); assert.match(svg, />04:10</);
	assert.doesNotMatch(svg, /44%|7D/);
	assert.equal((svg.match(/%<\/text>/g) ?? []).length, 1);
	assert.equal((svg.match(/width="120" height="12"/g) ?? []).length, 1);
});

test("weekly selection shows days, hours and minutes of its own reset", () => {
	const svg = renderUsageIcon(snapshot(), NOW, { window: "weekly" });
	assert.match(svg, />Claude 7D</); assert.match(svg, />44%</); assert.match(svg, />3d 05:00</);
	assert.doesNotMatch(svg, /73%|5H|04:10/);
});

test("selected limit color ignores a different exhausted window", () => {
	const snap = snapshot({ session: { usedPercent: 5, resetAt: null }, weekly: { usedPercent: 100, resetAt: null }, status: "limited" });
	const session = renderUsageIcon(snap, NOW, { window: "session" });
	assert.match(session, /fill="#34c759">5%/); assert.doesNotMatch(session, /#ff453a|100%/);
	const weekly = renderUsageIcon(snap, NOW, { window: "weekly" });
	assert.match(weekly, /fill="#ff453a">100%/); assert.doesNotMatch(weekly, /#34c759/);
});

test("percentage rounding and custom status thresholds apply to the selected limit", () => {
	const svg = renderUsageIcon(snapshot({ session: { usedPercent: 14.6, resetAt: null }, thresholds: { warning: 10, critical: 20 } }), NOW);
	assert.match(svg, /fill="#ffd60a">15%/);
});

test("automatic selection displays a weekly-only Codex account without a fictitious 5H row", () => {
	const svg = renderUsageIcon(snapshot({ provider: "codex", session: { usedPercent: null, resetAt: null } }), NOW);
	assert.match(svg, />Codex 7D</); assert.match(svg, />44%</); assert.match(svg, />3d 05:00</);
	assert.doesNotMatch(svg, /5H|No Data/);
});

test("explicitly unavailable limit shows No Data instead of a different limit", () => {
	const svg = renderUsageIcon(snapshot({ session: { usedPercent: null, resetAt: null } }), NOW, { window: "session" });
	assert.match(svg, /Claude 5H/); assert.match(svg, /No Data/); assert.doesNotMatch(svg, /44%/);
});

for (const status of ["ok", "warning", "critical", "limited", "stale", "auth_required", "rate_limited", "error"] as UsageStatus[]) {
	test(`background is exactly black for ${status}`, () => {
		const svg = renderUsageIcon(snapshot({ status }), NOW);
		assert.match(svg, /<rect width="144" height="144" fill="#000000"/);
		assert.doesNotMatch(svg, /#1c1c1e|#141414|#173d34|#46291f/);
	});
}

test("stale data retains the selected limit color and countdown with a subtle dot", () => {
	const svg = renderUsageIcon(snapshot({ stale: true, status: "stale" }), NOW);
	assert.match(svg, />73%</); assert.match(svg, />04:10</); assert.match(svg, /<circle/);
	assert.doesNotMatch(svg, /44%|STALE/);
});

for (const [status, message] of [["auth_required", "Login Required"], ["rate_limited", "Rate Limited"], ["error", "Error"]] as const) {
	test(`${status} shows its message without usage bars`, () => {
		const svg = renderUsageIcon(snapshot({ status }), NOW);
		assert.ok(svg.includes(message)); assert.doesNotMatch(svg, /73%|04:10|height="12"/);
	});
}

test("unknown reset shows a dash and expired reset shows 00:00", () => {
	const missing = renderUsageIcon(snapshot({ session: { usedPercent: 5, resetAt: null } }), NOW);
	assert.match(missing, />—</);
	const expired = renderUsageIcon(snapshot(), new Date("2026-06-01T00:00:00Z"), { window: "session" });
	assert.match(expired, />00:00</);
});

test("Copilot displays one monthly limit and the same minute-precision countdown", () => {
	const svg = renderUsageIcon(snapshot({ provider: "copilot" }), NOW, { window: "weekly" });
	assert.match(svg, />Copilot MO</); assert.match(svg, />73%</); assert.match(svg, />04:10</);
	assert.doesNotMatch(svg, /7D|5H|44%/);
});

test("unlimited Copilot plan has no fictitious percentage or countdown", () => {
	const svg = renderUsageIcon(snapshot({ provider: "copilot", session: { usedPercent: null, resetAt: "2026-06-03T05:00:00Z" } }), NOW);
	assert.match(svg, /No Data/); assert.doesNotMatch(svg, /44%|3d/);
});

test("SVG data URL round-trips", () => {
	const svg = renderUsageIcon(snapshot(), NOW);
	assert.equal(Buffer.from(toDataUrl(svg).split(",")[1], "base64").toString("utf-8"), svg);
});
