import streamDeck from "@elgato/streamdeck";
import { isUsageError } from "../../utils/errors.ts";
import { managedCodexSession } from "./codex-session.ts";

/** Inspector messages contain only commands and sanitized status text, never tokens/auth URLs. */
export function registerCodexAuthUI(): void {
	streamDeck.ui.onSendToPlugin((ev) => {
		const payload = ev.payload;
		if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.type !== "codex-auth") return;
		if (ev.action.manifestId !== "com.singerous.ai-limits.codex-usage" && ev.action.manifestId !== "com.singerous.ai-limits.usage-single") return;
		const reply = async (state: string, message: string) => {
			if (streamDeck.ui.action?.id === ev.action.id) await streamDeck.ui.sendToPropertyInspector({ type: "codex-auth", state, message });
		};
		void (async () => {
			const settings = await ev.action.getSettings();
			if (ev.action.manifestId === "com.singerous.ai-limits.usage-single" && settings.provider !== "codex") return;
			if (typeof settings.customCredentialsPath === "string" && settings.customCredentialsPath.trim()) {
				await reply("custom", "Custom credentials are read-only. Clear Credentials path to connect the plugin's separate Codex login.");
				return;
			}
			if (payload.command === "cancel") {
				await managedCodexSession.cancelLogin();
				await reply("disconnected", "Sign-in cancelled. Click Connect Codex to try again.");
			} else if (payload.command === "login") {
				await reply("connecting", "Opening Codex sign-in in your browser…");
				await managedCodexSession.login((url) => streamDeck.system.openUrl(url));
				await reply("connected", "Codex connected. Its official engine saves and renews the plugin's separate session.");
			} else if (payload.command === "status") {
				const status = await managedCodexSession.status();
				await reply(status.state, status.message);
			}
		})().catch(async (error) => {
			await reply("error", isUsageError(error) ? error.message : "Could not connect Codex. Please retry.").catch(() => {});
		});
	});
}
