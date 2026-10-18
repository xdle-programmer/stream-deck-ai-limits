import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";
import { authRequired, genericError } from "../../utils/errors.ts";
import type { ClaudeCredentials } from "./claude-credentials.ts";
import { readProfileKeychainBlob, writeProfileKeychainBlob } from "./claude-keychain.ts";

export function claudeProfileDirectory(): string {
	return path.join(os.homedir(), ".claude-stream-deck").normalize("NFC");
}

export function claudeProfileService(directory = claudeProfileDirectory()): string {
	return `Claude Code-credentials-${createHash("sha256").update(directory.normalize("NFC")).digest("hex").slice(0, 8)}`;
}

export interface ClaudeProfileRecord {
	document: Record<string, unknown> & { claudeAiOauth: Record<string, unknown> };
	source: "keychain" | "file";
}

export interface ClaudeProfileStore {
	read(): Promise<ClaudeProfileRecord>;
	write(record: ClaudeProfileRecord): Promise<void>;
	withLock<T>(run: () => Promise<T>): Promise<T>;
}

export function profileCredentials(record: ClaudeProfileRecord): ClaudeCredentials {
	const oauth = record.document.claudeAiOauth;
	return {
		accessToken: typeof oauth.accessToken === "string" ? oauth.accessToken : "",
		refreshToken: typeof oauth.refreshToken === "string" && oauth.refreshToken ? oauth.refreshToken : null,
		expiresAt: finiteNumber(oauth.expiresAt),
		refreshTokenExpiresAt: finiteNumber(oauth.refreshTokenExpiresAt),
		clientId: typeof oauth.clientId === "string" ? oauth.clientId : undefined,
	};
}

function finiteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The directory is fixed by the plugin, never supplied by the property inspector. */
export class DedicatedClaudeProfileStore implements ClaudeProfileStore {
	private lockCompromised = false;
	readonly directory: string;
	private readonly platform: NodeJS.Platform;
	private readonly keychain: { read: typeof readProfileKeychainBlob; write: typeof writeProfileKeychainBlob };
	constructor(
		directory = claudeProfileDirectory(),
		platform: NodeJS.Platform = process.platform,
		keychain = { read: readProfileKeychainBlob, write: writeProfileKeychainBlob },
	) { this.directory = directory; this.platform = platform; this.keychain = keychain; }

	async read(): Promise<ClaudeProfileRecord> {
		let contents: string | null = null;
		let source: ClaudeProfileRecord["source"] = "file";
		if (this.platform === "darwin") {
			contents = await this.keychain.read(claudeProfileService(this.directory));
			if (contents !== null) source = "keychain";
		}
		if (contents === null) {
			try { contents = await readFile(path.join(this.directory, ".credentials.json"), "utf-8"); }
			catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") {
					throw authRequired("Connect Claude in the key's settings to create a separate plugin login.");
				}
				throw genericError("Could not read Claude's plugin profile.");
			}
		}
		try {
			const document = JSON.parse(contents);
			if (!document || Array.isArray(document) || typeof document !== "object" ||
				!document.claudeAiOauth || typeof document.claudeAiOauth !== "object" || Array.isArray(document.claudeAiOauth)) throw new Error();
			return { document, source };
		} catch { throw authRequired("Claude's plugin login is invalid. Reconnect Claude in the key's settings."); }
	}

	async write(record: ClaudeProfileRecord): Promise<void> {
		if (this.lockCompromised) throw genericError("Claude's plugin login lock was lost. Retry shortly.");
		const contents = JSON.stringify(record.document);
		if (record.source === "keychain") {
			await this.keychain.write(claudeProfileService(this.directory), contents);
			return;
		}
		const temp = path.join(this.directory, `.credentials-${randomUUID()}.tmp`);
		try {
			await mkdir(this.directory, { recursive: true, mode: 0o700 });
			const handle = await open(temp, "wx", 0o600);
			try { await handle.writeFile(contents, "utf-8"); await handle.sync(); }
			finally { await handle.close(); }
			await rename(temp, path.join(this.directory, ".credentials.json"));
		} catch { throw genericError("Could not securely save Claude's plugin login. Check the profile directory permissions."); }
		finally { await rm(temp, { force: true }).catch(() => {}); }
	}

	/** Serializes plugin processes, including the terminal login helper. No CLI-wide lock is claimed. */
	async withLock<T>(run: () => Promise<T>): Promise<T> {
		let release: () => Promise<void>;
		try {
			await mkdir(this.directory, { recursive: true, mode: 0o700 });
			release = await lockfile.lock(this.directory, {
				lockfilePath: path.join(this.directory, ".stream-deck-auth.lock"),
				stale: 30_000, update: 5000,
				retries: { retries: 30, factor: 1, minTimeout: 500, maxTimeout: 500 },
				onCompromised: () => { this.lockCompromised = true; },
			});
		} catch {
			throw genericError("Claude sign-in or token refresh is already in progress, or its profile could not be locked. Retry shortly.");
		}
		this.lockCompromised = false;
		try {
			const result = await run();
			if (this.lockCompromised) throw genericError("Claude's plugin login lock was lost. Retry shortly.");
			return result;
		} finally { await release().catch(() => {}); }
	}
}
