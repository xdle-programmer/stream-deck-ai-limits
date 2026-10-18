import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

test("inspector login control sends commands only, handles progress and disables custom-file login", async () => {
	const elements = {
		"claude-auth": { hidden: false },
		"claude-connect": { disabled: false, textContent: "", addEventListener: (_: string, callback: () => void) => { click = callback; } },
		"claude-auth-status": { textContent: "" },
	};
	let click!: () => void;
	let settings!: (event: unknown) => void;
	let response!: (event: unknown) => void;
	const sent: unknown[] = [];
	const client = {
		send: async (event: string, payload: unknown) => { sent.push({ event, payload }); },
		sendToPropertyInspector: { subscribe: (callback: typeof response) => { response = callback; } },
		didReceiveSettings: { subscribe: (callback: typeof settings) => { settings = callback; } },
		getSettings: async () => ({ settings: { provider: "claude" } }),
	};
	const script = await readFile(new URL("../com.singerous.ai-limits.sdPlugin/ui/claude-auth.js", import.meta.url), "utf-8");
	vm.runInNewContext(script, { SDPIComponents: { streamDeckClient: client },
		document: { getElementById: (id: keyof typeof elements) => elements[id] }, setInterval: () => {} });
	await new Promise((resolve) => setImmediate(resolve));
	click();
	assert.equal(elements["claude-connect"].disabled, true);
	assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))), { event: "sendToPlugin", payload: { type: "claude-auth", command: "login" } });
	response({ payload: { type: "claude-auth", state: "connecting", message: "Browser sign-in" } });
	assert.equal(elements["claude-connect"].disabled, true);
	response({ payload: { type: "claude-auth", state: "connected", message: "Connected" } });
	assert.equal(elements["claude-connect"].disabled, false);
	assert.equal(elements["claude-connect"].textContent, "Reconnect Claude");
	settings({ payload: { settings: { provider: "claude", customCredentialsPath: "/custom/read-only.json" } } });
	assert.equal(elements["claude-connect"].disabled, true);
	settings({ payload: { settings: { provider: "codex" } } });
	assert.equal(elements["claude-auth"].hidden, true);
});
