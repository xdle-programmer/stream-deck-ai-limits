import test from "node:test";
import assert from "node:assert/strict";
import { renderSingleWindowIcon, type SingleWindowOptions } from "../src/render/single-window-icon.ts";
import { renderUsageIcon } from "../src/render/usage-icon.ts";
import type { UsageSnapshot } from "../src/providers/types.ts";

const snap: UsageSnapshot = {
	provider: "claude", session: { usedPercent: 18, resetAt: "2026-05-31T04:10:00Z" },
	weekly: { usedPercent: 73, resetAt: "2026-06-03T05:00:00Z" },
	fable: { usedPercent: 37, resetAt: "2026-06-03T05:07:00Z" },
	status: "ok", updatedAt: "2026-05-31T00:00:00Z", stale: false,
};
const options: SingleWindowOptions = { window: "session", providerAccent: "frame", now: new Date(snap.updatedAt) };

test("universal action uses the same single-limit layout and countdown as provider-specific keys", () => {
	assert.equal(renderSingleWindowIcon(snap, options), renderUsageIcon(snap, options.now, options));
	assert.match(renderSingleWindowIcon(snap, options), />18%</);
	assert.match(renderSingleWindowIcon(snap, options), />04:10</);
});

test("universal action respects the selected weekly or Fable window", () => {
	const weekly = renderSingleWindowIcon(snap, { ...options, window: "weekly" });
	assert.match(weekly, /Claude 7D/); assert.match(weekly, />73%</); assert.match(weekly, />3d 05:00</);
	assert.doesNotMatch(weekly, /18%|37%/);
	const fable = renderSingleWindowIcon(snap, { ...options, window: "fable" });
	assert.match(fable, /Claude FABLE/); assert.match(fable, />37%</); assert.match(fable, />3d 05:07</);
	assert.doesNotMatch(fable, /18%|73%/);
});

test("saved frame and none settings both render black keys without borders", () => {
	for (const providerAccent of ["frame", "none"] as const) {
		const svg = renderSingleWindowIcon(snap, { ...options, providerAccent });
		assert.match(svg, /<rect width="144" height="144" fill="#000000"/);
		assert.doesNotMatch(svg, /stroke=/);
	}
});

test("missing selected model limit shows No Data", () => {
	const svg = renderSingleWindowIcon({ ...snap, fable: undefined }, { ...options, window: "fable" });
	assert.match(svg, /No Data/); assert.doesNotMatch(svg, /18%|73%/);
});
