/* Only commands/status cross the inspector boundary. Official Codex owns OAuth and tokens. */
(() => {
	const client = SDPIComponents.streamDeckClient;
	const section = document.getElementById("codex-auth");
	const button = document.getElementById("codex-connect");
	const cancel = document.getElementById("codex-cancel");
	const status = document.getElementById("codex-auth-status");
	const defaultProvider = document.getElementById("claude-auth") ? "claude" : "codex";
	let isCodex = false;
	let customPath = false;
	let connecting = false;
	let requesting = false;
	function controls() { button.disabled = customPath || connecting || requesting; cancel.hidden = !connecting; }
	function updateSettings(settings) {
		isCodex = (settings.provider || defaultProvider) === "codex";
		customPath = typeof settings.customCredentialsPath === "string" && !!settings.customCredentialsPath.trim();
		section.hidden = !isCodex;
		controls();
		if (isCodex) void send("status");
	}
	async function send(command) {
		try { await client.send("sendToPlugin", { type: "codex-auth", command }); }
		catch {
			requesting = false;
			status.textContent = "Could not reach the plugin. Reselect the key and retry.";
			controls();
		}
	}
	client.sendToPropertyInspector.subscribe((event) => {
		const payload = event.payload;
		if (!payload || payload.type !== "codex-auth") return;
		requesting = false;
		connecting = payload.state === "connecting";
		status.textContent = payload.message;
		button.textContent = payload.state === "connected" ? "Reconnect Codex" : "Connect Codex";
		controls();
	});
	button.addEventListener("click", () => {
		if (button.disabled) return;
		requesting = true; controls();
		status.textContent = "Opening Codex sign-in in your browser…";
		void send("login");
	});
	cancel.addEventListener("click", () => { if (connecting) void send("cancel"); });
	client.didReceiveSettings.subscribe((event) => updateSettings(event.payload.settings));
	void client.getSettings().then((payload) => updateSettings(payload.settings));
	setInterval(() => { if (isCodex && !requesting) void send("status"); }, 3000);
})();
