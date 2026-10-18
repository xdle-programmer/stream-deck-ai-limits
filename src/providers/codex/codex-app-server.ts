import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { genericError } from "../../utils/errors.ts";

export type NotificationHandler = (method: string, params: Record<string, unknown>) => void;
export interface CodexConnection {
	request<T>(method: string, params?: Record<string, unknown>): Promise<T>;
	onNotification(callback: NotificationHandler): () => void;
	close(): void;
}

/** Raw errors stay inside the session manager, never in logs or the Property Inspector. */
export class CodexRpcError extends Error {
	readonly code: number;
	constructor(code: number, message: string) { super(message); this.code = code; }
}

/** Newline-delimited JSON RPC. No chat/thread/turn APIs or token export APIs are used. */
export class CodexAppServer implements CodexConnection {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly timeoutMs: number;
	private nextId = 0;
	private buffer = "";
	private closed = false;
	private readonly listeners = new Set<NotificationHandler>();
	private readonly pending = new Map<number, {
		resolve: (value: unknown) => void; reject: (error: unknown) => void;
		timer: ReturnType<typeof setTimeout>;
	}>();

	constructor(child: ChildProcessWithoutNullStreams, timeoutMs = 20_000) {
		this.child = child;
		this.timeoutMs = timeoutMs;
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.receive(chunk));
		// Diagnostics may include account data. Drain without logging/persisting them.
		child.stderr.resume();
		child.on("error", () => this.close());
		child.on("exit", () => this.close());
		child.stdin.on("error", () => this.close());
		process.once("exit", this.onExit);
	}

	private readonly onExit = () => { this.close(); };

	async initialize(): Promise<void> {
		await this.request("initialize", { clientInfo: { name: "stream_deck_ai_limits", title: "Stream Deck AI Limits", version: "0.5.1" } });
		this.write({ method: "initialized", params: {} });
	}

	request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
		if (this.closed) return Promise.reject(genericError("Codex connection closed. Retry or reconnect Codex."));
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				// A timed-out login request may still start a callback server: stop the entire child.
				this.close();
			}, this.timeoutMs);
			this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
			this.write({ id, method, params });
		});
	}

	onNotification(callback: NotificationHandler): () => void {
		this.listeners.add(callback);
		return () => this.listeners.delete(callback);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		process.removeListener("exit", this.onExit);
		this.child.stdin.end();
		this.child.kill();
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(genericError("Codex stopped responding. Check the connection and retry. If needed, update Codex."));
		}
		this.pending.clear();
		for (const callback of this.listeners) callback("connection/closed", {});
		this.listeners.clear();
		this.buffer = "";
	}

	private write(message: unknown): void {
		try { this.child.stdin.write(`${JSON.stringify(message)}\n`); } catch { this.close(); }
	}

	private receive(chunk: string): void {
		if (this.closed) return;
		this.buffer += chunk;
		if (this.buffer.length > 2 * 1024 * 1024) { this.close(); return; }
		let end: number;
		while ((end = this.buffer.indexOf("\n")) >= 0) {
			const line = this.buffer.slice(0, end);
			this.buffer = this.buffer.slice(end + 1);
			if (!line.trim()) continue;
			let message;
			try { message = JSON.parse(line); } catch { this.close(); return; }
			if (!message || typeof message !== "object" || Array.isArray(message)) { this.close(); return; }
			if (typeof message.method === "string") {
				if (message.id != null) {
					// Managed auth never asks the host for external tokens or tool approvals.
					this.write({ id: message.id, error: { code: -32601, message: "Unsupported method" } });
				} else {
					for (const callback of this.listeners) callback(message.method, message.params ?? {});
				}
			} else {
				const pending = this.pending.get(message.id);
				if (!pending) continue;
				this.pending.delete(message.id);
				clearTimeout(pending.timer);
				if (message.error) pending.reject(new CodexRpcError(message.error.code, typeof message.error.message === "string" ? message.error.message : "Codex request failed"));
				else pending.resolve(message.result);
			}
		}
	}
}

export function codexProfileDirectory(): string { return path.join(os.homedir(), ".codex-stream-deck"); }

/** Stream Deck's GUI PATH often omits terminal/npm directories. Only execute local binaries. */
export async function resolveCodexExecutable(): Promise<string> {
	const windows = process.platform === "win32";
	const names = windows ? ["codex.exe"] : ["codex"];
	const directories = [path.join(os.homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin",
		...(process.env.PATH ?? "").split(path.delimiter)];
	const candidates = directories.filter(path.isAbsolute).flatMap((dir) => names.map((name) => path.join(dir, name)));
	if (windows && process.env.APPDATA) {
		const npm = path.join(process.env.APPDATA, "npm/node_modules/@openai");
		const target = process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
		for (const pkg of ["codex", `codex-win32-${process.arch}`]) candidates.push(path.join(npm, pkg, "vendor", target, "codex/codex.exe"));
	}
	if (process.platform === "darwin") {
		for (const base of ["/Applications", path.join(os.homedir(), "Applications")]) {
			candidates.push(path.join(base, "Codex.app/Contents/Resources/codex"));
			candidates.push(path.join(base, "ChatGPT.app/Contents/Resources/codex-cli/bin/codex"));
			candidates.push(path.join(base, "ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"));
		}
	}
	for (const candidate of candidates) {
		try { await access(candidate, windows ? constants.F_OK : constants.X_OK); return candidate; } catch {}
	}
	throw genericError("Codex was not found. Install/update the Codex desktop app on macOS, or install Codex CLI (codex.exe on Windows), then reconnect.");
}

export async function startCodexAppServer(): Promise<CodexConnection> {
	const executable = await resolveCodexExecutable();
	const directory = codexProfileDirectory();
	await mkdir(directory, { recursive: true, mode: 0o700 });
	if (process.platform !== "win32") await chmod(directory, 0o700);
	const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: directory };
	// This login must belong to ChatGPT, not an inherited API key/provider override.
	for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "CODEX_HOME_OVERRIDE"]) delete env[key];
	const resolved = await realpath(executable);
	// npm's JS launcher needs Node even when Stream Deck was started with a minimal GUI PATH.
	const jsLauncher = resolved.endsWith(".js") || resolved.endsWith(".mjs");
	const server = new CodexAppServer(spawn(jsLauncher ? process.execPath : executable,
		[...(jsLauncher ? [resolved] : []), "-c", 'cli_auth_credentials_store="auto"', "app-server"],
		{ cwd: directory, env, stdio: "pipe", windowsHide: true, shell: false }));
	try { await server.initialize(); return server; } catch (err) { server.close(); throw err; }
}
