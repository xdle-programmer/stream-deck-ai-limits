/* Credentials stay in the plugin process / OS storage; this UI only exchanges status text. */
(() => {
	const client = SDPIComponents.streamDeckClient;
	const section = document.getElementById("claude-auth");
	const button = document.getElementById("claude-connect");
	const status = document.getElementById("claude-auth-status");
	let isClaude = true;
	let customPath = false;
	let connecting = false;
	let requesting = false;
	function updateSettings(settings) {
		isClaude = !settings.provider || settings.provider === "claude";
		customPath = typeof settings.customCredentialsPath === "string" && !!settings.customCredentialsPath.trim();
		section.hidden = !isClaude;
		button.disabled = customPath || connecting || requesting;
		if (isClaude) void send("status");
	}
	async function send(command) {
		try { await client.send("sendToPlugin", { type: "claude-auth", command }); }
		catch {
			requesting = false;
			status.textContent = "Could not reach the plugin. Reselect the key and retry.";
			button.disabled = customPath || connecting;
		}
	}
	client.sendToPropertyInspector.subscribe((event) => {
		const payload = event.payload;
		if (!payload || payload.type !== "claude-auth") return;
		requesting = false;
		connecting = payload.state === "connecting";
		status.textContent = payload.message;
		button.textContent = payload.state === "connected" ? "Reconnect Claude" : "Connect Claude";
		button.disabled = customPath || connecting;
	});
	button.addEventListener("click", () => {
		if (button.disabled) return;
		requesting = true;
		button.disabled = true;
		status.textContent = "Starting Claude sign-in…";
		void send("login");
	});
	client.didReceiveSettings.subscribe((event) => updateSettings(event.payload.settings));
	void client.getSettings().then((payload) => updateSettings(payload.settings));
	// Also works after reselecting a key while the browser login is still open.
	setInterval(() => { if (isClaude && !requesting) void send("status"); }, 3000);
})();
