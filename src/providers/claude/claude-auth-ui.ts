import streamDeck from "@elgato/streamdeck";
import { isUsageError } from "../../utils/errors.ts";
import { launchClaudeLogin } from "./claude-login.ts";
import { DedicatedClaudeProfileStore, profileCredentials } from "./claude-profile.ts";
import { managedClaudeSession } from "./claude-session.ts";

/** All messages are secret-free. PI input can request an action, never a command/path/token. */
export function registerClaudeAuthUI(): void {
	streamDeck.ui.onSendToPlugin((ev) => {
		const payload = ev.payload;
		if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.type !== "claude-auth") return;
		if (ev.action.manifestId !== "com.singerous.ai-limits.claude-usage" && ev.action.manifestId !== "com.singerous.ai-limits.usage-single") return;
		const reply = async (state: string, message: string) => {
			if (streamDeck.ui.action?.id === ev.action.id) {
				await streamDeck.ui.sendToPropertyInspector({ type: "claude-auth", state, message });
			}
		};
		void (async () => {
			const settings = await ev.action.getSettings();
			if (typeof settings.customCredentialsPath === "string" && settings.customCredentialsPath.trim()) {
				await reply("custom", "Custom credentials are read-only. Clear Credentials path to connect the plugin's separate login.");
				return;
			}
			if (managedClaudeSession.isLoggingIn) {
				await reply("connecting", "Complete Claude sign-in in the browser and terminal window.");
				return;
			}
			if (payload.command === "login") {
				await reply("connecting", "Opening Claude sign-in. Complete it in the browser and terminal window.");
				try {
					await managedClaudeSession.login(launchClaudeLogin);
					await managedClaudeSession.getAccessToken();
					await reply("connected", "Claude connected. The plugin renews this login automatically while allowed by Claude.");
				} catch (err) {
					await reply("error", isUsageError(err) ? err.message : "Claude sign-in failed. Please retry.");
				}
			} else if (payload.command === "status") {
				try {
					const credentials = profileCredentials(await new DedicatedClaudeProfileStore().read());
					if (managedClaudeSession.needsReconnect || !credentials.refreshToken || (credentials.refreshTokenExpiresAt != null && credentials.refreshTokenExpiresAt <= Date.now())) {
						await reply("disconnected", "Connect Claude to create or renew the plugin's separate login.");
					} else {
						await reply("connected", "Plugin login saved. Access tokens are renewed automatically when needed.");
					}
				} catch (err) {
					await reply(isUsageError(err) && err.status === "auth_required" ? "disconnected" : "error",
						isUsageError(err) ? err.message : "Could not check Claude sign-in.");
				}
			}
		})().catch(() => { /* Never let SDK/transport errors expose credentials or crash the plugin. */ });
	});
}
