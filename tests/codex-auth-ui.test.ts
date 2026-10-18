import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

test("Codex inspector has browser login/cancel, follows provider selection and rejects custom-file login", async () => {
	let click!: () => void; let cancel!: () => void;
	let settings!: (event: unknown) => void; let response!: (event: unknown) => void;
	const elements = {
		"claude-auth": {}, "codex-auth": { hidden: false },
		"codex-connect": { disabled: false, textContent: "", addEventListener: (_: string, cb: () => void) => { click = cb; } },
		"codex-cancel": { hidden: true, addEventListener: (_: string, cb: () => void) => { cancel = cb; } },
		"codex-auth-status": { textContent: "" },
	};
	const sent: { type: string; command: string }[] = [];
	const client = {
		send: async (_: string, payload: typeof sent[number]) => { sent.push(payload); },
		sendToPropertyInspector: { subscribe: (cb: typeof response) => { response = cb; } },
		didReceiveSettings: { subscribe: (cb: typeof settings) => { settings = cb; } },
		getSettings: async () => ({ settings: {} }),
	};
	const script = await readFile(new URL("../com.singerous.ai-limits.sdPlugin/ui/codex-auth.js", import.meta.url), "utf-8");
	vm.runInNewContext(script, { SDPIComponents: { streamDeckClient: client },
		document: { getElementById: (id: keyof typeof elements) => elements[id] }, setInterval: () => {} });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(elements["codex-auth"].hidden, true); assert.equal(sent.length, 0);
	settings({ payload: { settings: { provider: "codex" } } });
	assert.equal(elements["codex-auth"].hidden, false);
	click(); assert.equal(elements["codex-connect"].disabled, true);
	assert.equal(sent.at(-1)?.command, "login"); assert.equal(sent.at(-1)?.type, "codex-auth");
	response({ payload: { type: "codex-auth", state: "connecting", message: "Complete browser sign-in" } });
	assert.equal(elements["codex-cancel"].hidden, false);
	cancel(); assert.equal(sent.at(-1)?.command, "cancel");
	response({ payload: { type: "codex-auth", state: "connected", message: "Login saved" } });
	assert.equal(elements["codex-connect"].textContent, "Reconnect Codex"); assert.equal(elements["codex-cancel"].hidden, true);
	settings({ payload: { settings: { provider: "codex", customCredentialsPath: "~/auth.json" } } });
	assert.equal(elements["codex-connect"].disabled, true);
	settings({ payload: { settings: { provider: "copilot" } } }); assert.equal(elements["codex-auth"].hidden, true);
});
