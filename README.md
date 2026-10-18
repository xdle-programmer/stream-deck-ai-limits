# Claude & Codex Usage — Stream Deck plugin

Show your **Claude Code**, **Codex CLI**, and **GitHub Copilot** usage limits right on your Elgato
Stream Deck keys.

Each key displays **one selected limit**: the percentage used, a colored progress bar, and the
time until reset, on a **pure black** background. The countdown shows `04:10` for four hours and
ten minutes, or `3d 05:00` for three days and five hours. It updates every minute without an API
request. Claude offers **5-hour**, **weekly**, and **Fable weekly** limits; Codex shows the windows
returned for your account, which may include only a **weekly** limit. Copilot has a **monthly
premium-interactions** quota. No tokens to paste — connect Claude or Codex in the key's settings.
Each gets a separate plugin login with automatic renewal. Copilot reuses its CLI login.

> [!WARNING]
> Claude, Copilot, and the optional custom-file Codex integration use **unofficial / internal
> endpoints** that may change without notice. Default Codex integration uses its official local
> app-server account API; this requires a compatible installed Codex engine.

---

## What it looks like

Four action types (drag any of them onto a key):

| Action | Shows |
| --- | --- |
| **Claude Usage** | One Claude limit: 5-hour, weekly, or Fable weekly + reset countdown |
| **Codex Usage** | One available Codex limit: 5-hour or weekly + reset countdown |
| **Copilot Usage** | Monthly **premium interactions** usage + reset countdown |
| **Usage (single window)** | Choose any provider and one limit, using the same layout |

Select the **Limit** in the key's settings. To see both Claude windows, add two keys and choose
**5-hour** on one and **7-day (weekly)** on the other. **Automatic** prefers the available 5-hour
window and falls back to weekly; a weekly-only Codex account therefore gets a weekly key. Codex
windows are identified by the duration returned by the API, rather than their primary/secondary
position. An explicitly selected but unavailable limit shows **No Data**.

Positive fractions of a minute round up: the final seconds display `00:01`, and elapsed windows
display `00:00`. A missing reset time displays `—`.

Color bands (configurable): `0–69%` green · `70–89%` yellow · `90–99%` orange · `100%` red.

---

## Requirements

- **Elgato Stream Deck** app 6.5+ (Windows 10+ or macOS 12+).
- For Claude usage: **[Claude Code](https://www.anthropic.com/claude-code)** installed. Click
  **Connect Claude** in the key's settings and finish the official login in your browser/terminal.
  This creates a separate plugin login; an existing CLI or Desktop login is not reused.
- For Codex usage: **[Codex CLI](https://developers.openai.com/codex)** or the macOS desktop app with
  its bundled Codex engine installed. Click **Connect Codex** in the key's settings and sign in
  with your ChatGPT account in the browser. No terminal interaction is needed for login. Tested
  with CLI 0.160.1 and the bundled engine 0.163.0-alpha.10.2; older engines may require an update.
- For Copilot usage: **[GitHub CLI](https://cli.github.com/)** installed and logged in
  (`gh auth login`). The token is read from `gh auth token` — optionally via a custom
  `hosts.yml`-style file — see [Copilot](#copilot).

You only need the CLI for the provider(s) you want to display.

---

## Installation

### From a release (recommended)

1. Download the latest `com.singerous.ai-limits.streamDeckPlugin` from the
   [Releases](https://github.com/Sing3Rous/stream-deck-ai-limits/releases) page.
2. Double-click it — the Stream Deck app installs it.
3. Find the **Claude & Codex Usage** category in the actions list and drag an action onto a key.

### From source (development)

```bash
npm install
npm run build
# link the plugin into the Stream Deck app and start it:
npx streamdeck link com.singerous.ai-limits.sdPlugin
npx streamdeck restart com.singerous.ai-limits
```

`npm run watch` rebuilds and restarts the plugin on change.

---

## Settings (Property Inspector)

Select a key to configure it:

- **Refresh interval** — how often to poll (60–600 s, default 120 s). The minimum is 60 s on
  purpose; see [Polling & rate limits](#polling--rate-limits).
- **Warning / Critical thresholds** — the percentages at which a bar turns yellow / orange.
- **Credentials path** — optional override if your credentials file is in a non-standard location.
  For Claude and Codex, leave empty to use the separate plugin login with automatic token renewal.
  Custom Claude/Codex credentials files are **read-only**: their owner must renew them, and the
  Connect button is disabled until the path is cleared. Copilot uses its usual CLI credentials.

### Codex login and automatic renewal

1. Select a **Codex Usage** key, or a single-window key with **Provider: Codex**.
2. Clear **Credentials path**, click **Connect Codex**, and sign in with your ChatGPT account in
   the browser. Use **Cancel sign-in** if you want to stop an unfinished login.
3. The keys refresh automatically when sign-in completes. Use **Reconnect Codex** if the server
   revokes the login or requires a new browser sign-in.

The plugin runs the official `codex app-server` over local stdio with a separate
`CODEX_HOME=~/.codex-stream-deck`. Codex performs OAuth, saves the credentials, and renews tokens.
With `cli_auth_credentials_store="auto"`, it prefers the OS credential store and falls back to
that profile's `auth.json`. The profile directory has owner-only POSIX permissions. The ordinary
Codex CLI/app login is not reused or modified. Keep this profile dedicated to Stream Deck.

All Codex keys share one engine/session. The plugin only calls account login/status/rate-limit
methods; it creates no chats, runs no prompts, and receives no access or refresh tokens. Limits
come from `account/rateLimits/read` and retain their returned window durations, including
weekly-only accounts. See the official [app-server authentication documentation](https://learn.chatgpt.com/docs/app-server#authentication-endpoints).

The legacy custom-file mode still reads an explicitly selected `auth.json` without refreshing or
writing it. An HTTP `403` in this mode can be edge protection or an access restriction, and no
longer claims your login has expired. Clear the path and use **Connect Codex** to switch modes.

### Claude login and automatic renewal

1. Select a **Claude Usage** key, or a single-window key with **Provider: Claude**.
2. Leave **Credentials path** empty and click **Connect Claude**.
3. Complete the official Claude Code login in the browser and terminal window, using the account
   whose limits you want to display. The key refreshes when login completes.

The plugin uses `~/.claude-stream-deck` as a dedicated `CLAUDE_CONFIG_DIR`. On macOS its credentials
are stored in a separate, directory-specific **login Keychain** item. On Windows (and the macOS
file fallback created by Claude Code) they stay in that profile's `.credentials.json`, written
atomically with owner-only POSIX permissions where supported and inherited user-directory ACLs
on Windows. The plugin preserves metadata and saves rotated access/refresh tokens and supplied
expiry timestamps after renewal, so the updated login survives restarts.

All Claude keys share one session manager, independent of thresholds and polling intervals. A
profile lock serializes plugin processes and pauses renewal during the Connect flow. The ordinary
Claude Code/Desktop credential entry is never modified. Do not use this dedicated profile for
other Claude Code sessions, or copy existing CLI tokens into it: a fresh login creates the isolated
session that makes independent renewal possible.

If the server expires or revokes the login, use **Reconnect Claude**. Network errors, throttling,
and server failures retain credentials and retry later. Automatic renewal cannot bypass a required
browser sign-in, and both usage and token endpoints remain unofficial integrations.

For manual troubleshooting, this is the same isolated login (the variable applies only to this
command; it does not change your normal shell configuration):

```bash
CLAUDE_CONFIG_DIR="$HOME/.claude-stream-deck" claude auth login --claudeai
```

Use the button when Stream Deck is running so background renewal is paused during sign-in.

Claude and Codex keys include a **Limit** selector. The **single-window** action additionally
selects the **Provider** (Claude/Codex/Copilot). Copilot always shows its monthly quota. All keys
use the compact reset countdown, a strictly black background and **no border**; legacy date/time,
hidden-reset, tinted-background and colored-frame settings are ignored.

### Copilot

The Copilot action shows your monthly **premium interactions** quota: a bar for how much of the
month you've used, plus a countdown such as `12d 05:30` to the quota reset.

**This window is specific to Copilot — it has no equivalent for Claude or Codex.** Premium
interactions are the requests GitHub meters against your plan (the premium models and agent modes);
ordinary completions and base-model chat are unmetered and are not shown here. Unlike Claude's and
Codex's rolling windows, this quota is a **calendar-month allowance tied to your billing cycle**.
The Copilot key always selects this monthly window.

- **Endpoint** — this reads the **unofficial internal endpoint**
  `GET https://api.github.com/copilot_internal/user` (the same one the GitHub CLI's Copilot
  subcommands use). It is **not** a public API and may change or break without notice.
- **Token** — resolved in this order:
  1. a custom **credentials path** you set in the Property Inspector (a bare token, or a
     `hosts.yml`-style file with `github.com: → oauth_token:`);
  2. the GitHub CLI's own `hosts.yml` (`%APPDATA%\GitHub CLI\hosts.yml` on Windows,
     `~/.config/gh/hosts.yml` elsewhere, or `$GH_CONFIG_DIR/hosts.yml` if set);
  3. `gh auth token` — the GitHub CLI must be installed and authenticated (`gh auth login`).
- **Settings** — the Copilot PI has the same refresh interval (60–600 s, default 120 s), warning /
  critical thresholds (70 / 90), and an optional credentials-path override. Copilot always uses the
  **session** window; there is no weekly window, so the single-window action fixes the window
  dropdown to the session for Copilot.

Changes apply live — no need to restart the plugin.

---

## Polling & rate limits

The usage endpoints are rate-limited. In particular, Claude's endpoint allows only a few requests
per 5-minute window and then returns `429` with a 5-minute back-off. The plugin therefore:

- defaults to polling every **120 s** and enforces a **60 s minimum**;
- **shares one request** only across keys with the same provider, refresh interval, resolved
  credentials path, and thresholds (matching keys don't multiply calls);
- **throttles key-press refreshes** (a press fetches at most once per 10 s; otherwise it just
  re-draws the cached value);
- on a `429`, **backs off** (honoring `Retry-After`) and keeps showing the last known numbers with a
  small "stale" dot instead of blanking the key.

Pressing a key forces an immediate refresh (subject to the throttle above).

---

## Security

- The plugin uses **local credentials** created by the official Claude Code / Codex login flows, or
  obtained from the GitHub CLI (`gh auth token`). It never asks you to paste a token.
- Claude's rotated tokens are saved **only in its dedicated plugin profile**, in the macOS Keychain
  or the protected credentials file described above. Existing CLI credentials and custom credentials
  files are read-only. Tokens are never written to Stream Deck settings or Property Inspector messages.
- Codex's official app-server owns its separate login, storage and renewal. Its stderr and raw RPC
  errors are never forwarded to plugin logs or the inspector; only sanitized status text is shown.
- Tokens and `Authorization` headers are **never logged**.
- Usage data is sent **only** to the provider's own usage endpoint — nowhere else. No telemetry.
- On macOS, Claude's Keychain item is read via the absolute path `/usr/bin/security`, so a binary
  of that name earlier in your `PATH` cannot intercept the call.
- Keychain writes pass hex-encoded credential data on stdin, never in process arguments. Failed
  writes keep the pending rotation in memory for a later save rather than immediately reusing the
  consumed refresh token. If the process exits before that save succeeds, a reconnect may be needed.
- **`gh` is resolved through `PATH`**, unlike the above. The GitHub CLI has no fixed install
  location (Homebrew, winget, scoop, nix and manual installs all differ), so pinning one path would
  break more setups than it protects. This is a deliberate trade-off: writing to a `PATH` directory
  already implies enough access to read the same token straight out of `hosts.yml`, so the
  substitution gains an attacker nothing they could not do more simply. If that trade-off doesn't
  suit your machine, set an explicit **Credentials path** in the Property Inspector — that skips
  the `gh` subprocess entirely.

---

## Troubleshooting

| Key shows | Meaning | Fix |
| --- | --- | --- |
| **Login Required** | Login missing, expired or rejected. | Claude/Codex: clear Credentials path and use **Connect/Reconnect** in the key's settings. For a custom file, renew it with its owner. Copilot: log in with its CLI. |
| **Rate Limited** | The endpoint returned `429`. | Wait — it recovers automatically. Avoid spamming the key; increase the refresh interval if it persists. |
| **Error** | Network error or an unexpected response. | Check your connection. If it persists, the unofficial endpoint may have changed — please file an issue. |
| Small dot in the corner | Data is stale (a refresh failed); the numbers shown are the last known good ones. | Usually transient; it clears on the next successful refresh. |

Plugin logs are under `com.singerous.ai-limits.sdPlugin/logs/`. They never contain tokens, but
review before sharing.

---

## Known limitations

- Claude/Copilot and custom-file Codex use **unofficial endpoints**. Default Codex integration
  requires its app-server account API; update the installed engine if it reports an unsupported method.
- Automatic renewal cannot bypass a revoked login or a server requirement for browser sign-in.
- The Copilot key needs a **metered premium-interactions quota** to draw a bar. Plans that report the
  quota as unlimited show **No Data**, with no countdown — there is no percentage to display.
- The plugin pins the Stream Deck **Node 20** runtime (the Node 24 runtime mishandles a header the
  Codex endpoint requires).

---

## License

[MIT](LICENSE).
