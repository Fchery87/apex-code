import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { LspClient, LspTextDocumentSync } from "./client.ts";

export interface SynchronizedDocument {
	readonly uri: string;
	readonly version: number;
}

interface OpenDocument {
	readonly client: LspClient;
	readonly languageId: string;
	readonly uri: string;
	version: number;
	text: string;
}

function positionAtEnd(text: string): { line: number; character: number } {
	const lines = text.split("\n");
	return { line: lines.length - 1, character: lines[lines.length - 1]?.length ?? 0 };
}

/** Keeps versioned, whole-document disk snapshots open for a pool lifetime. */
export class LspDocumentSync {
	private readonly documents = new Map<string, OpenDocument>();

	synchronize(client: LspClient, path: string, languageId: string): SynchronizedDocument | undefined {
		const capabilities = client.textDocumentSync;
		if (capabilities.kind === "none") return undefined;
		const uri = pathToFileURL(path).href;
		const text = readFileSync(path, "utf8");
		const current = this.documents.get(uri);
		if (!current) {
			const document: OpenDocument = { client, languageId, text, uri, version: 1 };
			this.documents.set(uri, document);
			client.notify("textDocument/didOpen", {
				textDocument: { uri, languageId, version: document.version, text },
			});
			this.notifySaved(document, capabilities);
			return document;
		}
		if (current.client !== client || current.languageId !== languageId) {
			throw new Error(`LSP document ${uri} changed server or language while open.`);
		}
		if (!Number.isSafeInteger(current.version + 1)) throw new Error(`LSP document version exhausted for ${uri}.`);
		const nextVersion = current.version + 1;
		const contentChanges =
			capabilities.kind === "full"
				? [{ text }]
				: [
						{
							range: { start: { line: 0, character: 0 }, end: positionAtEnd(current.text) },
							text,
						},
					];
		current.version = nextVersion;
		current.text = text;
		client.notify("textDocument/didChange", {
			textDocument: { uri, version: nextVersion },
			contentChanges,
		});
		this.notifySaved(current, capabilities);
		return current;
	}

	dispose(): void {
		for (const document of this.documents.values()) {
			if (!document.client.textDocumentSync.openClose) continue;
			try {
				document.client.notify("textDocument/didClose", { textDocument: { uri: document.uri } });
			} catch {
				// A failed server cannot accept teardown notifications.
			}
		}
		this.documents.clear();
	}

	private notifySaved(document: OpenDocument, capabilities: LspTextDocumentSync): void {
		if (!capabilities.save) return;
		document.client.notify("textDocument/didSave", {
			textDocument: { uri: document.uri },
			...(capabilities.saveIncludeText ? { text: document.text } : {}),
		});
	}
}
