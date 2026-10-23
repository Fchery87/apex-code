import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findGitPaths } from "./footer-data-provider.ts";

const MAX_LINES = 200;
const MAX_BYTES = 25 * 1024;
const SECRET = /api_key\s*=|token\s*=|password\s*=|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;

export interface MemoryNoteInput {
	title: string;
	body: string;
}

export interface AppendedMemoryNote {
	name?: string;
	path?: string;
	refused?: string;
}

export interface LoadedMemoryNotes {
	text: string;
	cut?: string;
}

/** The note store lives at the git repo root, so every worktree of that repo shares it. */
export function memoryRoot(cwd: string): string {
	const git = findGitPaths(cwd);
	const base = git ? join(git.commonGitDir, "..") : cwd;
	return join(base, ".apex-code", "memory");
}

function inboxDir(cwd: string): string {
	return join(memoryRoot(cwd), "inbox");
}

function acceptedDir(cwd: string): string {
	return join(memoryRoot(cwd), "accepted");
}

function secretRefusal(body: string): string | undefined {
	if (SECRET.test(body)) return "Refused: the note contains a secret.";
	return undefined;
}

export function appendMemoryNote(cwd: string, note: MemoryNoteInput): AppendedMemoryNote {
	const refused = secretRefusal(`${note.title}\n${note.body}`);
	if (refused) return { refused };
	const dir = inboxDir(cwd);
	mkdirSync(dir, { recursive: true });
	const name = `${Date.now()}-${note.title.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 40) || "note"}.md`;
	const path = join(dir, name);
	writeFileSync(path, `# ${note.title}\n\n${note.body}\n`, "utf-8");
	return { name, path };
}

export function acceptMemoryNote(cwd: string, name: string): void {
	if (name.includes("/") || name.includes("\\") || name.includes("..")) {
		throw new Error(`Refused: note name "${name}" is not a single file name.`);
	}
	const from = join(inboxDir(cwd), name);
	const dir = acceptedDir(cwd);
	mkdirSync(dir, { recursive: true });
	renameSync(from, join(dir, name));
}

export function loadAcceptedMemoryNotes(cwd: string, options: { projectTrusted: boolean }): LoadedMemoryNotes {
	if (!options.projectTrusted) return { text: "" };
	const dir = acceptedDir(cwd);
	if (!existsSync(dir)) return { text: "" };
	const names = readdirSync(dir)
		.filter((name) => name.endsWith(".md"))
		.sort();
	let text = "";
	let cut: string | undefined;
	for (const name of names) {
		const body = readFileSync(join(dir, name), "utf-8");
		const chunk = body.split("\n").slice(2).join("\n");
		const next = text.length === 0 ? chunk : `${text}\n${chunk}`;
		const lines = next.split("\n");
		if (lines.length > MAX_LINES) {
			text = lines.slice(0, MAX_LINES).join("\n");
			cut = "200 lines";
			break;
		}
		if (Buffer.byteLength(next, "utf-8") > MAX_BYTES) {
			text = next.slice(0, MAX_BYTES);
			cut = "25 KB";
			break;
		}
		text = next;
	}
	return { text, cut };
}
