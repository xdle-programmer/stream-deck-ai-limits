import test from "node:test";
import assert from "node:assert/strict";

import { formatResetTime, formatCountdown } from "../src/utils/time.ts";

// Use a fixed local time. We build the Date from local components so the test is timezone-stable
// for the formatter (which reads local fields).
function localISO(y: number, mo: number, d: number, h: number, mi: number): string {
	return new Date(y, mo - 1, d, h, mi, 0).toISOString();
}

test("formatResetTime: day-month", () => {
	const iso = localISO(2026, 5, 31, 14, 6);
	assert.equal(formatResetTime(iso, "day-month"), "31 May, 14:06");
});

test("formatResetTime: iso-short", () => {
	const iso = localISO(2026, 5, 31, 14, 6);
	assert.equal(formatResetTime(iso, "iso-short"), "05/31 14:06");
});

test("formatResetTime: weekday (2026-05-31 is a Sunday)", () => {
	const iso = localISO(2026, 5, 31, 9, 5);
	assert.equal(formatResetTime(iso, "weekday"), "Sun 09:05");
});

test("formatResetTime: pads single-digit day/hour/minute", () => {
	const iso = localISO(2026, 1, 3, 4, 7);
	assert.equal(formatResetTime(iso, "day-month"), "3 Jan, 04:07");
	assert.equal(formatResetTime(iso, "iso-short"), "01/03 04:07");
});

test("formatResetTime: null / invalid → null", () => {
	assert.equal(formatResetTime(null), null);
	assert.equal(formatResetTime("not-a-date"), null);
});

test("formatCountdown: hours and minutes", () => {
	const now = new Date("2026-05-31T06:08:00Z");
	const target = new Date("2026-05-31T14:06:00Z").toISOString();
	assert.equal(formatCountdown(target, now), "07:58");
});

test("formatCountdown: under an hour → minutes only", () => {
	const now = new Date("2026-05-31T06:00:00Z");
	const target = new Date("2026-05-31T06:42:00Z").toISOString();
	assert.equal(formatCountdown(target, now), "00:42");
});

test("formatCountdown: multi-day keeps hours and minutes", () => {
	const now = new Date("2026-05-31T06:00:00Z");
	const target = new Date("2026-06-03T10:00:00Z").toISOString();
	assert.equal(formatCountdown(target, now), "3d 04:00");
});

test("formatCountdown: past / now → '00:00'", () => {
	const now = new Date("2026-05-31T15:00:00Z");
	const target = new Date("2026-05-31T14:00:00Z").toISOString();
	assert.equal(formatCountdown(target, now), "00:00");
});

test("formatCountdown: null / invalid → null", () => {
	assert.equal(formatCountdown(null), null);
	assert.equal(formatCountdown("nope"), null);
	assert.equal(formatCountdown("2026-06-03T10:00:00Z", new Date("invalid")), null);
});

test("formatCountdown: requested examples, minute precision and day boundaries", () => {
	const now = new Date("2026-05-31T00:00:00Z");
	for (const [minutes, expected] of [[250, "04:10"], [3 * 1440 + 5 * 60, "3d 05:00"],
		[3 * 1440 + 5 * 60 + 7, "3d 05:07"], [1440, "1d 00:00"], [0, "00:00"]] as const) {
		assert.equal(formatCountdown(new Date(now.getTime() + minutes * 60_000).toISOString(), now), expected);
	}
	assert.equal(formatCountdown(new Date(now.getTime() + 1).toISOString(), now), "00:01");
	assert.equal(formatCountdown(new Date(now.getTime() + 60_001).toISOString(), now), "00:02");
});
