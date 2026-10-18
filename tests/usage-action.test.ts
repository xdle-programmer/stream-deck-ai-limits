import test from "node:test";
import assert from "node:assert/strict";
import type { KeyAction, WillAppearEvent, WillDisappearEvent, DidReceiveSettingsEvent } from "@elgato/streamdeck";
import { UsageActionBase } from "../src/actions/usage-action-base.ts";
import type { Provider, UsageSnapshot } from "../src/providers/types.ts";
import type { UsageActionSettings } from "../src/settings/usage-settings.ts";

const NOW = new Date("2026-05-31T00:00:00Z");
const SNAPSHOT: UsageSnapshot = {
	provider: "claude", session: { usedPercent: 34, resetAt: "2026-05-31T04:10:00Z" },
	weekly: { usedPercent: 73, resetAt: "2026-06-03T05:00:00Z" },
	status: "ok", stale: false, updatedAt: NOW.toISOString(),
};

class TestUsageAction extends UsageActionBase {
	protected readonly providerId = "claude" as const;
	readonly getUsage: () => Promise<UsageSnapshot>;
	factories = 0;
	constructor(getUsage: () => Promise<UsageSnapshot>) { super(); this.getUsage = getUsage; }
	protected createProvider(): Provider { this.factories++; return { getUsage: this.getUsage }; }
}

function fakeKey() {
	const images: string[] = [];
	const key = { id: "test-key", isKey: () => true,
		setImage: async (url: string) => { images.push(Buffer.from(url.split(",")[1], "base64").toString("utf-8")); } } as unknown as KeyAction;
	const appear = (settings: UsageActionSettings) => ({ action: key, payload: { settings } }) as unknown as WillAppearEvent<UsageActionSettings>;
	const disappear = { action: key } as unknown as WillDisappearEvent<UsageActionSettings>;
	return { images, key, appear, disappear };
}

test("countdown ticks every minute without fetching usage and stops when the key disappears", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW });
	let fetches = 0;
	const action = new TestUsageAction(async () => { fetches++; return SNAPSHOT; });
	const key = fakeKey();
	await action.onWillAppear(key.appear({ refreshIntervalSec: 600, window: "session" }));
	assert.match(key.images.at(-1)!, />04:10</);
	t.mock.timers.tick(60_000);
	assert.match(key.images.at(-1)!, />04:09</);
	assert.equal(fetches, 1);
	action.onWillDisappear(key.disappear);
	const frames = key.images.length;
	t.mock.timers.tick(600_000);
	assert.equal(fetches, 1); assert.equal(key.images.length, frames);
});

test("changing a provider-specific key's limit applies live without replacing its provider", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW });
	const action = new TestUsageAction(async () => SNAPSHOT); const key = fakeKey();
	await action.onWillAppear(key.appear({ window: "session" }));
	assert.match(key.images.at(-1)!, />34%</);
	await action.onDidReceiveSettings(key.appear({ window: "weekly" }) as unknown as DidReceiveSettingsEvent<UsageActionSettings>);
	assert.match(key.images.at(-1)!, />73%</); assert.match(key.images.at(-1)!, />3d 05:00</);
	assert.equal(action.factories, 1);
	action.onWillDisappear(key.disappear);
});

test("a key hidden during an in-flight fetch cannot restart timers or draw stale results", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW });
	let complete!: (snapshot: UsageSnapshot) => void; let fetches = 0;
	const action = new TestUsageAction(() => { fetches++; return new Promise((resolve) => { complete = resolve; }); });
	const key = fakeKey();
	const appearing = action.onWillAppear(key.appear({}));
	action.onWillDisappear(key.disappear);
	complete(SNAPSHOT); await appearing;
	t.mock.timers.tick(600_000);
	assert.equal(fetches, 1); assert.equal(key.images.length, 0);
});

test("a late response from before reconnect cannot overwrite the newer key display", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW });
	let complete!: (snapshot: UsageSnapshot) => void; let calls = 0;
	const action = new TestUsageAction(() => ++calls === 1 ? new Promise((resolve) => { complete = resolve; }) : Promise.resolve(SNAPSHOT));
	const key = fakeKey(); const first = action.onWillAppear(key.appear({}));
	await action.onDidReceiveSettings(key.appear({}) as unknown as DidReceiveSettingsEvent<UsageActionSettings>);
	assert.match(key.images.at(-1)!, />34%</);
	const frames = key.images.length;
	complete({ ...SNAPSHOT, status: "auth_required" }); await first;
	assert.equal(key.images.length, frames);
	action.onWillDisappear(key.disappear);
});
