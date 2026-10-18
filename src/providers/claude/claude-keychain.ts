import { execFile, spawn } from "node:child_process";
import { userInfo } from "node:os";
import { promisify } from "node:util";
import { genericError } from "../../utils/errors.ts";

const execFileAsync = promisify(execFile);

/** Generic-password service name Claude Code uses for its macOS Keychain item. */
export const KEYCHAIN_SERVICE = "Claude Code-credentials";

/**
 * Absolute path rather than a bare name: `/etc/paths` puts `/usr/local/bin` ahead of
 * `/usr/bin`, so a PATH-resolved `security` could be shadowed by a planted binary on Macs
 * where that directory is user-writable — and this call hands back an OAuth token.
 */
const SECURITY_BIN = "/usr/bin/security";

/** Give up rather than stall a key refresh if the Keychain prompts or hangs. */
const KEYCHAIN_TIMEOUT_MS = 5_000;

/** The blob is a few KB in practice; cap it so a pathological item can't balloon memory. */
const KEYCHAIN_MAX_BYTES = 64 * 1024;

/**
 * Read Claude Code's credential blob from the macOS login Keychain.
 *
 * On macOS the `claude` login flow stores its OAuth payload as a Keychain item instead of
 * writing `~/.claude/.credentials.json`, so the file that other platforms read never exists.
 * The stored payload is the *same* JSON shape as that file, which lets callers parse the
 * result with identical logic.
 *
 * @returns The raw JSON string, or `null` when the item is absent or unreadable.
 */
export async function readClaudeKeychainBlob(): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync(
			SECURITY_BIN,
			["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
			{ encoding: "utf-8", timeout: KEYCHAIN_TIMEOUT_MS, maxBuffer: KEYCHAIN_MAX_BYTES },
		);
		const blob = stdout.trim();
		return blob.length > 0 ? blob : null;
	} catch {
		// Item missing, Keychain locked, access denied, or `security` unavailable all mean the
		// same thing to the caller: no credentials here. The raw error is deliberately swallowed
		// rather than wrapped, because `security` echoes the item it failed on.
		return null;
	}
}

/** Strict reader for the plugin-owned profile: a locked Keychain is not a missing login. */
export async function readProfileKeychainBlob(service: string): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync(SECURITY_BIN,
			["find-generic-password", "-a", keychainAccount(), "-s", service, "-w"],
			{ encoding: "utf-8", timeout: KEYCHAIN_TIMEOUT_MS, maxBuffer: KEYCHAIN_MAX_BYTES });
		const value = stdout.trim();
		return /^[0-9a-f]+$/i.test(value) && value.length % 2 === 0
			? Buffer.from(value, "hex").toString("utf-8") : value || null;
	} catch (err) {
		if ((err as { code?: unknown }).code === 44) return null;
		throw genericError("Could not read Claude's plugin profile from Keychain. Unlock the login Keychain and retry.");
	}
}

export function keychainAccount(): string {
	const account = process.env.USER || userInfo().username;
	return /^[a-zA-Z0-9._-]+$/.test(account) ? account : "claude-code-user";
}

/** Keep secrets off argv. Claude Code itself uses security -i with hex data on stdin. */
export async function writeProfileKeychainBlob(service: string, contents: string): Promise<void> {
	if (!/^Claude Code-credentials-[a-f0-9]{8}$/.test(service)) {
		throw genericError("Refusing to write outside Claude's dedicated plugin profile.");
	}
	const command = `add-generic-password -U -a "${keychainAccount()}" -s "${service}" -X "${Buffer.from(contents).toString("hex")}"\n`;
	// security's interactive command buffer is 4096 bytes. Never fall back to secret argv.
	if (Buffer.byteLength(command) > 3900) throw genericError("Claude plugin credentials are too large to save securely.");
	await new Promise<void>((resolve, reject) => {
		const child = spawn(SECURITY_BIN, ["-i"], { stdio: ["pipe", "ignore", "ignore"] });
		const fail = () => reject(genericError("Could not save Claude's plugin profile in Keychain. Unlock the login Keychain and retry."));
		const timer = setTimeout(() => { child.kill(); fail(); }, KEYCHAIN_TIMEOUT_MS);
		child.on("error", () => { clearTimeout(timer); fail(); });
		child.stdin.on("error", fail);
		child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve() : fail(); });
		child.stdin.end(command);
	});
	// security -i can exit successfully even when an individual command failed.
	if (await readProfileKeychainBlob(service) !== contents) {
		throw genericError("Claude plugin credentials could not be verified after saving to Keychain.");
	}
}
