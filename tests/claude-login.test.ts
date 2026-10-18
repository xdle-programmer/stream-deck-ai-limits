import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { makeClaudeLoginScript, powershellQuote } from "../src/providers/claude/claude-login.ts";

for (const exitCode of [0, 7]) {
	test(`macOS login helper safely quotes paths, isolates credentials and reports exit ${exitCode}`, { skip: process.platform === "win32" }, async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "claude-login-test-"));
		try {
			const cli = path.join(dir, "fake ' cli");
			const observed = path.join(dir, "observed");
			const result = path.join(dir, "result ' file");
			const profile = path.join(dir, "profile ' with spaces $(touch CANARY_EXECUTED)");
			// No real CLI or browser. The fake records only harmless test environment values.
			await writeFile(cli, `#!/bin/sh\nprintf '%s\\n' "$CLAUDE_CONFIG_DIR" "$CLAUDE_SECURESTORAGE_CONFIG_DIR" "\${ANTHROPIC_API_KEY-unset}" "$@" > "$TEST_OBSERVED"\nexit ${exitCode}\n`, { mode: 0o700 });
			const script = path.join(dir, "login.command");
			await writeFile(script, makeClaudeLoginScript("darwin", cli, profile, result));
			try { await promisify(execFile)("/bin/sh", [script], { cwd: dir, env: { ...process.env, TEST_OBSERVED: observed, ANTHROPIC_API_KEY: "FAKE_OVERRIDE" } }); }
			catch (err) { assert.equal((err as { code: number }).code, exitCode); }
			assert.equal(await readFile(result, "utf-8"), String(exitCode));
			assert.deepEqual((await readFile(observed, "utf-8")).trim().split("\n"), [profile, profile, "unset", "auth", "login", "--claudeai"]);
			await assert.rejects(() => stat(path.join(dir, "CANARY_EXECUTED")));
		} finally { await rm(dir, { recursive: true, force: true }); }
	});
}

test("Windows login script uses PowerShell literal quoting and the isolated profile", () => {
	const profile = "C:\\Users\\O'Brien\\.claude-stream-deck";
	const script = makeClaudeLoginScript("win32", "C:\\Program Files\\Claude\\claude.exe", profile, "C:\\Temp\\result");
	assert.ok(script.includes(`$env:CLAUDE_CONFIG_DIR = ${powershellQuote(profile)}`));
	assert.ok(script.includes("& 'C:\\Program Files\\Claude\\claude.exe' auth login --claudeai"));
	assert.ok(script.includes("finally"));
	assert.ok(script.includes("Remove-Item Env:CLAUDE_CODE_OAUTH_TOKEN"));
});

test("closing the macOS sign-in helper cancels its CLI child and reports cancellation", { skip: process.platform === "win32" }, async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "claude-cancel-test-"));
	let cliPid: number | undefined;
	let helper: ReturnType<typeof spawn> | undefined;
	try {
		const cli = path.join(dir, "fake-cli"); const pidFile = path.join(dir, "cli-pid");
		const result = path.join(dir, "result"); const script = path.join(dir, "login.command");
		await writeFile(cli, '#!/bin/sh\nprintf "%s" "$$" > "$TEST_PID_FILE"\nexec /bin/sleep 30\n', { mode: 0o700 });
		await writeFile(script, makeClaudeLoginScript("darwin", cli, dir, result));
		helper = spawn("/bin/sh", [script], { stdio: "ignore", env: { ...process.env, TEST_PID_FILE: pidFile } });
		const closed = new Promise((resolve) => helper!.once("exit", resolve));
		for (let i = 0; i < 100; i++) {
			const pid = Number(await readFile(pidFile, "utf-8").catch(() => ""));
			if (pid > 0) { cliPid = pid; break; }
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.ok(cliPid, "fake CLI must start");
		helper.kill("SIGTERM"); await closed;
		assert.equal(await readFile(result, "utf-8"), "130");
		assert.throws(() => process.kill(cliPid!, 0), (err: NodeJS.ErrnoException) => err.code === "ESRCH");
	} finally {
		helper?.kill("SIGTERM");
		if (cliPid) { try { process.kill(cliPid, "SIGTERM"); } catch {} }
		await rm(dir, { recursive: true, force: true });
	}
});
