import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findSecrets } from "../../scripts/scrub-session.ts";

const corpusDirectory = fileURLToPath(new URL("../corpus", import.meta.url));

async function corpusFiles(): Promise<string[]> {
	return (await readdir(corpusDirectory))
		.filter((name) => name.endsWith(".jsonl"))
		.sort()
		.map((name) => join(corpusDirectory, name));
}

async function corpusAllFiles(): Promise<string[]> {
	return (await readdir(corpusDirectory)).sort().map((name) => join(corpusDirectory, name));
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
	if (value === null || typeof value !== "object") throw new Error(`expected object: ${context}`);
	return Object.fromEntries(Object.entries(value));
}

function assertIsoTimestamp(value: unknown, context: string): number {
	if (typeof value !== "string") throw new Error(`missing timestamp: ${context}`);
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) throw new Error(`invalid timestamp: ${context}`);
	return timestamp;
}

function expectString(value: unknown, context: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`expected string: ${context}`);
	return value;
}

function isAncestor(
	candidate: string,
	descendant: string | null,
	parentById: ReadonlyMap<string, string | null>,
): boolean {
	let current = descendant;
	while (current !== null) {
		if (current === candidate) return true;
		current = parentById.get(current) ?? null;
	}
	return false;
}

describe("replay corpus", () => {
	it("contains 8–12 representative sessions", async () => {
		const files = await corpusFiles();
		expect(files.length).toBeGreaterThanOrEqual(8);
		expect(files.length).toBeLessThanOrEqual(12);
		expect(files.map((file) => basename(file))).toEqual(
			expect.arrayContaining([
				"short-single-turn.jsonl",
				"long-multi-turn.jsonl",
				"compacted-session.jsonl",
				"heavy-tool-output.jsonl",
				"model-switch.jsonl",
				"error-recovery.jsonl",
			]),
		);
	});

	it("contains only documented files and no sensitive values", async () => {
		const files = await corpusAllFiles();
		expect(files.map((file) => basename(file))).toEqual(expect.arrayContaining(["README.md"]));
		expect(files.every((file) => basename(file) === "README.md" || extname(file) === ".jsonl")).toBe(true);
		for (const file of files) {
			const text = await readFile(file, "utf8");
			expect(text).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
			expect(findSecrets(text), `sensitive value in ${file}`).toHaveLength(0);
			expect(text).not.toMatch(/\/(?:home|Users)\/(?!\$)/);
			expect(text).not.toMatch(/[A-Za-z]:[\\/]Users[\\/]/i);
			expect(text).not.toMatch(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
		}
	});

	it("is valid JSONL with native tree, references, and tool-call semantics", async () => {
		for (const file of await corpusFiles()) {
			const raw = await readFile(file, "utf8");
			const lines = raw.trimEnd().split("\n");
			expect(raw.endsWith("\n"), `missing final newline in ${file}`).toBe(true);
			expect(
				lines.every((line) => line.trim().length > 0),
				`blank line in ${file}`,
			).toBe(true);
			const entries = lines.map((line, index) => asRecord(JSON.parse(line), `${file}:${index + 1}`));
			const header = entries[0];
			expect(header).toMatchObject({
				type: "session",
				version: 3,
				id: expect.any(String),
				cwd: "$HOME/replay-fixtures",
			});
			expect(entries.filter((entry) => entry.type === "session")).toHaveLength(1);
			expect(header.id).toEqual(expect.stringMatching(/^[a-z][a-z0-9-]{1,31}$/));
			let lastTimestamp = assertIsoTimestamp(header.timestamp, `${file}:1`);

			const ids = new Set<string>();
			const parentById = new Map<string, string | null>();
			const pendingTools = new Map<string, { name: string; entryId: string }>();
			let roots = 0;
			for (const [index, entry] of entries.slice(1).entries()) {
				expect(entry).toEqual(expect.objectContaining({ type: expect.any(String), id: expect.any(String) }));
				const { id, parentId, type } = entry;
				if (
					typeof id !== "string" ||
					(parentId !== null && typeof parentId !== "string") ||
					typeof type !== "string"
				) {
					throw new Error(`invalid entry identity in ${file}:${index + 2}`);
				}
				const timestamp = assertIsoTimestamp(entry.timestamp, `${file}:${index + 2}`);
				expect(timestamp, `timestamps out of order in ${file}`).toBeGreaterThanOrEqual(lastTimestamp);
				lastTimestamp = timestamp;
				expect(id).toMatch(/^[a-z][a-z0-9-]{1,31}$/);
				expect(ids.has(id), `duplicate id ${id} in ${file}`).toBe(false);
				if (parentId === null) roots++;
				else expect(ids.has(parentId), `missing parent ${parentId} in ${file}`).toBe(true);
				parentById.set(id, parentId);

				switch (type) {
					case "message":
						asRecord(entry.message, `${file} message`);
						break;
					case "model_change":
						expectString(entry.provider, `${file} provider`);
						expectString(entry.modelId, `${file} model`);
						break;
					case "compaction":
						expectString(entry.summary, `${file} summary`);
						expectString(entry.firstKeptEntryId, `${file} first kept entry`);
						if (typeof entry.tokensBefore !== "number" || entry.tokensBefore < 0)
							throw new Error(`invalid compaction tokens in ${file}`);
						break;
					case "branch_summary":
						expectString(entry.summary, `${file} summary`);
						expectString(entry.fromId, `${file} from id`);
						break;
					case "label":
						expectString(entry.targetId, `${file} target id`);
						break;
					case "thinking_level_change":
						expectString(entry.thinkingLevel, `${file} thinking level`);
						break;
					case "custom":
					case "custom_message":
					case "session_info":
						break;
					default:
						throw new Error(`unknown entry type ${type} in ${file}`);
				}

				for (const key of ["firstKeptEntryId", "fromId", "targetId"] as const) {
					const reference = entry[key];
					if (typeof reference === "string")
						expect(ids.has(reference), `missing ${key} ${reference} in ${file}`).toBe(true);
				}
				if (type === "compaction" && typeof entry.firstKeptEntryId === "string") {
					let ancestor: string | null = parentId;
					while (ancestor !== null && ancestor !== entry.firstKeptEntryId)
						ancestor = parentById.get(ancestor) ?? null;
					expect(ancestor, `compaction target is not an ancestor in ${file}`).toBe(entry.firstKeptEntryId);
				}

				if (type === "message") {
					const message = asRecord(entry.message, `${file}:${index + 2} message`);
					const role = message.role;
					if (!new Set(["user", "assistant", "toolResult"]).has(String(role)))
						throw new Error(`invalid role in ${file}`);
					if (role === "assistant") {
						const nestedTimestamp = message.timestamp;
						if (typeof nestedTimestamp !== "number" || !Number.isFinite(nestedTimestamp))
							throw new Error(`invalid message timestamp in ${file}`);
						const usage = asRecord(message.usage, `${file} usage`);
						for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
							const value = usage[key];
							if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
								throw new Error(`invalid usage ${key} in ${file}`);
						}
						expect(usage.totalTokens).toBe(
							Number(usage.input) + Number(usage.output) + Number(usage.cacheRead) + Number(usage.cacheWrite),
						);
						const content = Array.isArray(message.content) ? message.content : [];
						for (const part of content.map((value) => asRecord(value, `${file} assistant content`))) {
							if (part.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string") {
								expect(pendingTools.has(part.id), `duplicate tool call ${part.id} in ${file}`).toBe(false);
								pendingTools.set(part.id, { name: part.name, entryId: id });
							}
						}
						if (message.stopReason === "toolUse")
							expect(content.some((part) => asRecord(part, file).type === "toolCall")).toBe(true);
						if (message.stopReason === "error") expect(typeof message.errorMessage).toBe("string");
					}
					if (role === "toolResult") {
						const callId = message.toolCallId;
						if (typeof callId !== "string") throw new Error(`tool result lacks call id in ${file}`);
						const call = pendingTools.get(callId);
						expect(call?.name, `orphan tool result ${callId} in ${file}`).toBe(message.toolName);
						expect(
							call && isAncestor(call.entryId, parentId, parentById),
							`tool result off call branch in ${file}`,
						).toBe(true);
						pendingTools.delete(callId);
					}
				}
				ids.add(id);
			}
			expect(roots, `expected one root in ${file}`).toBe(1);
			expect(pendingTools, `unresolved tool calls in ${file}`).toEqual(new Map());
		}
	});

	it("covers the phase's required replay behaviors", async () => {
		const documents = await Promise.all(
			(await corpusFiles()).map(async (file) => ({ file, text: await readFile(file, "utf8") })),
		);
		const all = documents.flatMap(({ text }) =>
			text
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>),
		);
		expect(all.filter((entry) => entry.type === "compaction").length).toBeGreaterThan(0);
		expect(all.filter((entry) => entry.type === "model_change").length).toBeGreaterThan(0);
		expect(
			all.filter((entry) => entry.type === "message" && Reflect.get(entry.message ?? {}, "role") === "toolResult")
				.length,
		).toBeGreaterThan(0);
		expect(all.filter((entry) => Reflect.get(entry.message ?? {}, "stopReason") === "error").length).toBeGreaterThan(
			0,
		);
		const long = documents.find(({ file }) => file.endsWith("long-multi-turn.jsonl"));
		const longEntries =
			long?.text
				.split("\n")
				.filter(Boolean)
				.map((line) => asRecord(JSON.parse(line), "long fixture")) ?? [];
		expect(
			longEntries.filter((entry) => entry.type === "message" && Reflect.get(entry.message ?? {}, "role") === "user")
				.length,
		).toBeGreaterThanOrEqual(20);
		const compacted = documents.find(({ file }) => file.endsWith("compacted-session.jsonl"));
		expect(compacted?.text.match(/"role":"user"/g)?.length).toBeGreaterThanOrEqual(20);
	});
});
