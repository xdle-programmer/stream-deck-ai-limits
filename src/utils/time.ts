/**
 * Reset-time formatting for the single-window key.
 *
 * All helpers take the reset timestamp as an ISO string (from `UsageWindow.resetAt`) and a
 * reference `now`, so they are deterministic and unit-testable. Output is intentionally short to
 * fit a Stream Deck key.
 */

export type DateFormat = "day-month" | "iso-short" | "weekday";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function pad2(n: number): string {
	return n < 10 ? `0${n}` : `${n}`;
}

/**
 * Format an absolute reset time in local time.
 *  - `day-month` → `31 May, 14:06`
 *  - `iso-short` → `05/31 14:06`
 *  - `weekday`   → `Sat 14:06`
 * Returns `null` for a missing/invalid timestamp.
 */
export function formatResetTime(isoString: string | null, format: DateFormat = "day-month"): string | null {
	if (!isoString) {
		return null;
	}
	const d = new Date(isoString);
	if (Number.isNaN(d.getTime())) {
		return null;
	}
	const hh = pad2(d.getHours());
	const mm = pad2(d.getMinutes());
	switch (format) {
		case "iso-short":
			return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${hh}:${mm}`;
		case "weekday":
			return `${WEEKDAYS[d.getDay()]} ${hh}:${mm}`;
		case "day-month":
		default:
			return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${hh}:${mm}`;
	}
}

/**
 * Minute-precision reset countdown: `04:10` or `3d 05:00`.
 * Round positive partial minutes up, so `00:00` means the reset has actually arrived.
 * Returns `null` for a missing/invalid timestamp.
 */
export function formatCountdown(isoString: string | null, now: Date = new Date()): string | null {
	if (!isoString) {
		return null;
	}
	const target = new Date(isoString);
	if (!Number.isFinite(target.getTime()) || !Number.isFinite(now.getTime())) {
		return null;
	}
	const diffMs = target.getTime() - now.getTime();
	if (diffMs <= 0) {
		return "00:00";
	}
	const totalMinutes = Math.ceil(diffMs / 60_000);
	const days = Math.floor(totalMinutes / (60 * 24));
	const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
	const minutes = totalMinutes % 60;

	return `${days > 0 ? `${days}d ` : ""}${pad2(hours)}:${pad2(minutes)}`;
}
