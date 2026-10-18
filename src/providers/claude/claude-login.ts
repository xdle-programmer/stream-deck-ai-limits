import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { genericError } from "../../utils/errors.ts";
import { claudeProfileDirectory } from "./claude-profile.ts";

const execFileAsync = promisify(execFile);
const LOGIN_TIMEOUT_MS = 10 * 60_000;
// Inherited provider overrides must not send this isolated login to a different service.
const AUTH_ENVIRONMENT = [
	"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_PROFILE",
	"CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_CUSTOM_OAUTH_URL", "CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
];

export function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
export function powershellQuote(value: string): string { return `'${value.replaceAll("'", "''")}'`; }

/** Only fixed commands and quoted, locally resolved paths; no tokens or PI-supplied commands. */
export function makeClaudeLoginScript(platform: NodeJS.Platform, cli: string, directory: string, result: string): string {
	if (platform === "win32") {
		const q = powershellQuote;
		return [
			"$ErrorActionPreference = 'Stop'", "$loginResult = 1",
			...AUTH_ENVIRONMENT.map((key) => `Remove-Item Env:${key} -ErrorAction SilentlyContinue`),
			`$env:CLAUDE_CONFIG_DIR = ${q(directory)}`, `$env:CLAUDE_SECURESTORAGE_CONFIG_DIR = ${q(directory)}`,
			"try {", `  & ${q(cli)} auth login --claudeai`, "  $loginResult = $LASTEXITCODE",
			"} finally {", `  [IO.File]::WriteAllText(${q(result)}, [string]$loginResult)`, "}",
			"Write-Host 'You can close this window and return to Stream Deck.'",
		].join("\r\n");
	}
	const q = shellQuote;
	return [
		"#!/bin/sh",
		`printf '%s' "$$" > ${q(`${result}.pid`)}`,
		"login_pid=",
		`trap ${q(`login_result=$?; if [ -n "$login_pid" ]; then kill "$login_pid" 2>/dev/null || true; wait "$login_pid" 2>/dev/null || true; fi; printf "%s" "$login_result" > ${q(result)}`)} EXIT`,
		"trap 'exit 130' HUP INT TERM",
		`/usr/bin/env ${AUTH_ENVIRONMENT.map((key) => `-u ${key}`).join(" ")} CLAUDE_CONFIG_DIR=${q(directory)} CLAUDE_SECURESTORAGE_CONFIG_DIR=${q(directory)} ${q(cli)} auth login --claudeai <&0 &`,
		"login_pid=$!", "wait \"$login_pid\"", "login_result=$?", "login_pid=",
		"printf '\\nYou can close this window and return to Stream Deck.\\n'", "exit \"$login_result\"", "",
	].join("\n");
}

export async function resolveClaudeExecutable(): Promise<string> {
	const windows = process.platform === "win32";
	const names = windows ? ["claude.exe", "claude.cmd"] : ["claude"];
	const directories = [path.join(os.homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin",
		...(process.env.PATH ?? "").split(path.delimiter)];
	if (windows && process.env.APPDATA) directories.push(path.join(process.env.APPDATA, "npm"));
	for (const directory of directories) {
		if (!path.isAbsolute(directory)) continue;
		for (const name of names) {
			const file = path.join(directory, name);
			try { await access(file, windows ? constants.F_OK : constants.X_OK); return file; } catch {}
		}
	}
	throw genericError("Claude Code was not found. Install Claude Code, then click Connect Claude again.");
}

/** Terminal owns the interactive browser flow; only a numeric exit code is read back. */
export async function launchClaudeLogin(): Promise<void> {
	if (process.platform !== "darwin" && process.platform !== "win32") {
		throw genericError("The Claude sign-in button is supported on macOS and Windows.");
	}
	const cli = await resolveClaudeExecutable();
	const temp = await mkdtemp(path.join(os.tmpdir(), "stream-deck-claude-login-"));
	const result = path.join(temp, "result");
	const script = path.join(temp, process.platform === "darwin" ? "Connect Claude.command" : "Connect Claude.ps1");
	let helperPid: number | undefined;
	let completed = false;
	let windowsHelperExited = false;
	try {
		await writeFile(script, makeClaudeLoginScript(process.platform, cli, claudeProfileDirectory(), result), { mode: 0o700 });
		if (process.platform === "darwin") {
			try { await execFileAsync("/usr/bin/open", ["-a", "Terminal", script], { timeout: 5000 }); }
			catch { throw genericError("Could not open Terminal for Claude sign-in."); }
		} else {
			const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
			await new Promise<void>((resolve, reject) => {
				const child = spawn(powershell, ["-NoProfile", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", script],
					{ detached: true, stdio: "ignore", windowsHide: false });
				child.once("error", () => reject(genericError("Could not open PowerShell for Claude sign-in.")));
				child.once("exit", () => { windowsHelperExited = true; });
				child.once("spawn", () => { helperPid = child.pid; child.unref(); resolve(); });
			});
		}
		const deadline = Date.now() + LOGIN_TIMEOUT_MS;
		for (;;) {
			if (process.platform === "darwin" && helperPid === undefined) {
				try {
					const pid = Number(await readFile(`${result}.pid`, "utf-8"));
					if (Number.isSafeInteger(pid) && pid > 0) helperPid = pid;
				} catch {}
			}
			let code: string | undefined;
			try { code = (await readFile(result, "utf-8")).trim(); } catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw genericError("Could not check Claude sign-in completion.");
			}
			if (code !== undefined && code !== "") {
				completed = true;
				if (code !== "0") throw genericError("Claude sign-in was cancelled or failed. Click Connect Claude to try again.");
				return;
			}
			if (windowsHelperExited) throw genericError("Claude sign-in window was closed. Click Connect Claude to try again.");
			if (helperPid && process.platform === "darwin") {
				try { process.kill(helperPid, 0); }
				catch {
					// The successful helper can exit between the result read and the PID check.
					helperPid = undefined;
					const finalCode = await readFile(result, "utf-8").catch(() => "");
					if (finalCode.trim() === "0") { completed = true; return; }
					throw genericError("Claude sign-in window was closed or sign-in failed. Click Connect Claude to try again.");
				}
			}
			if (Date.now() > deadline) throw genericError("Claude sign-in timed out. Click Connect Claude to try again.");
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
	} finally {
		// Stop the pending sign-in before releasing the session lock on timeout/failure.
		if (!completed && helperPid) {
			if (process.platform === "win32" && !windowsHelperExited) {
				await execFileAsync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
					["/PID", String(helperPid), "/T", "/F"], { timeout: 5000 }).catch(() => {});
			} else if (process.platform === "darwin") {
				try { process.kill(helperPid, "SIGTERM"); } catch {}
				// Let the shell's exit trap terminate its CLI child and write the result.
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
		}
		await rm(temp, { recursive: true, force: true });
	}
}
