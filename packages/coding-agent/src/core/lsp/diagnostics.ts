import { pathToFileURL } from "node:url";
import type { DiagnosticUnavailableKind } from "../tools/contract.ts";
import type { LspClient, LspNotification } from "./client.ts";
import type { LspPool } from "./pool.ts";
import { LspDocumentSync } from "./sync.ts";

export interface DiagnosticPosition {
	readonly line: number;
	readonly character: number;
}

export interface DiagnosticRange {
	readonly start: DiagnosticPosition;
	readonly end: DiagnosticPosition;
}

export interface Diagnostic {
	readonly range: DiagnosticRange;
	readonly severity?: number;
	readonly code?: string | number;
	readonly source?: string;
	readonly message: string;
}

export type DiagnosticsOutcome =
	| {
			readonly status: "ok";
			readonly serverId: string;
			readonly diagnostics: readonly Diagnostic[];
			readonly truncated: boolean;
	  }
	| {
			readonly status: "unavailable";
			readonly serverId?: string;
			readonly unavailableKind: DiagnosticUnavailableKind;
			readonly reason: string;
	  };

interface PublishDiagnostics {
	readonly uri: string;
	readonly version?: number;
	readonly diagnostics: readonly Diagnostic[];
}

interface Waiter {
	readonly version: number;
	readonly serverId: string;
	readonly resolve: (outcome: DiagnosticsOutcome) => void;
	readonly timer: NodeJS.Timeout;
	readonly removeAbort: () => void;
}

const MAX_DIAGNOSTICS = 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPosition(value: unknown): value is DiagnosticPosition {
	return (
		isRecord(value) &&
		Number.isSafeInteger(value.line) &&
		(value.line as number) >= 0 &&
		Number.isSafeInteger(value.character) &&
		(value.character as number) >= 0
	);
}

function isDiagnostic(value: unknown): value is Diagnostic {
	if (!isRecord(value) || typeof value.message !== "string" || !isRecord(value.range)) return false;
	if (!isPosition(value.range.start) || !isPosition(value.range.end)) return false;
	if (value.severity !== undefined && !Number.isSafeInteger(value.severity)) return false;
	if (value.code !== undefined && typeof value.code !== "string" && typeof value.code !== "number") return false;
	if (value.source !== undefined && typeof value.source !== "string") return false;
	return true;
}

function parsePublish(notification: LspNotification): PublishDiagnostics | undefined {
	if (notification.method !== "textDocument/publishDiagnostics" || !isRecord(notification.params)) return undefined;
	const { uri, version, diagnostics } = notification.params;
	if (typeof uri !== "string" || !Array.isArray(diagnostics) || !diagnostics.every(isDiagnostic)) return undefined;
	if (version !== undefined && (!Number.isSafeInteger(version) || (version as number) < 0)) return undefined;
	return { uri, ...(version === undefined ? {} : { version: version as number }), diagnostics };
}

function unavailableReason(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Synchronizes disk snapshots and attributes diagnostics only to their exact document version. */
export class LspDiagnostics {
	private readonly pool: LspPool;
	private readonly sync = new LspDocumentSync();
	private readonly waiters = new Map<string, Set<Waiter>>();
	private readonly unsubscribeByClient = new Map<LspClient, () => void>();
	private disposed = false;

	constructor(pool: LspPool) {
		this.pool = pool;
	}

	async afterMutation(path: string, signal?: AbortSignal): Promise<DiagnosticsOutcome> {
		if (this.disposed)
			return { status: "unavailable", unavailableKind: "disposed", reason: "diagnostics are disposed" };
		let selectedServerId: string | undefined;
		try {
			const connection = await this.pool.acquire(path);
			if (this.disposed) {
				return {
					status: "unavailable",
					...(connection === undefined ? {} : { serverId: connection.selection.server.id }),
					unavailableKind: "disposed",
					reason: "diagnostics are disposed",
				};
			}
			if (!connection)
				return {
					status: "unavailable",
					unavailableKind: "no-server",
					reason: "no language server configured for path",
				};
			const serverId = connection.selection.server.id;
			selectedServerId = serverId;
			// `connection.selection.path` is the registry's canonicalized form of `path`
			// (symlinks resolved -- see `registry.ts`'s `selectLspServerForPath`). It must
			// be the one URI-keying basis used everywhere below: `sync.synchronize()` opens
			// the document under this canonical path, so a waiter keyed by the caller's raw
			// `path` would never match the publish it's waiting for wherever the two forms
			// differ (e.g. macOS's /tmp -> /private/tmp), timing out instead of resolving.
			const canonicalPath = connection.selection.path;
			this.subscribe(connection.client);
			const nextVersion = this.peekNextVersion(canonicalPath);
			const pending = this.waitFor(
				this.uri(canonicalPath),
				nextVersion,
				serverId,
				connection.selection.server.diagnosticsTimeoutMs,
				signal,
			);
			const document = this.sync.synchronize(
				connection.client,
				connection.selection.path,
				connection.selection.languageId,
			);
			if (!document) {
				pending.cancel();
				return {
					status: "unavailable",
					serverId,
					unavailableKind: "unsupported-sync",
					reason: "language server does not support text document synchronization",
				};
			}
			if (document.version !== nextVersion) {
				pending.cancel();
				return {
					status: "unavailable",
					serverId,
					unavailableKind: "server-failed",
					reason: "document synchronization version changed unexpectedly",
				};
			}
			return await pending.outcome;
		} catch (error) {
			if (this.disposed) {
				return {
					status: "unavailable",
					...(selectedServerId === undefined ? {} : { serverId: selectedServerId }),
					unavailableKind: "disposed",
					reason: "diagnostics are disposed",
				};
			}
			return {
				status: "unavailable",
				...(selectedServerId === undefined ? {} : { serverId: selectedServerId }),
				unavailableKind: "server-failed",
				reason: unavailableReason(error),
			};
		}
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.sync.dispose();
		for (const unsubscribe of this.unsubscribeByClient.values()) unsubscribe();
		this.unsubscribeByClient.clear();
		for (const [uri, waiters] of this.waiters) {
			for (const waiter of [...waiters])
				this.settle(uri, waiter, {
					status: "unavailable",
					serverId: waiter.serverId,
					unavailableKind: "disposed",
					reason: "diagnostics are disposed",
				});
		}
	}

	private readonly versions = new Map<string, number>();

	private uri(path: string): string {
		return pathToFileURL(path).href;
	}

	private peekNextVersion(path: string): number {
		const uri = this.uri(path);
		const version = (this.versions.get(uri) ?? 0) + 1;
		this.versions.set(uri, version);
		return version;
	}

	private subscribe(client: LspClient): void {
		if (this.unsubscribeByClient.has(client)) return;
		this.unsubscribeByClient.set(
			client,
			client.onNotification((notification) => this.onNotification(notification)),
		);
	}

	private waitFor(
		uri: string,
		version: number,
		serverId: string,
		timeoutMs: number,
		signal?: AbortSignal,
	): {
		readonly outcome: Promise<DiagnosticsOutcome>;
		readonly cancel: () => void;
	} {
		let waiter: Waiter;
		const outcome = new Promise<DiagnosticsOutcome>((resolve) => {
			const abort = () =>
				this.settle(uri, waiter, {
					status: "unavailable",
					serverId,
					unavailableKind: "aborted",
					reason: "diagnostics aborted",
				});
			const timer = setTimeout(
				() =>
					this.settle(uri, waiter, {
						status: "unavailable",
						serverId,
						unavailableKind: "timed-out",
						reason: `timed out after ${timeoutMs}ms`,
					}),
				timeoutMs,
			);
			signal?.addEventListener("abort", abort, { once: true });
			waiter = { version, serverId, resolve, timer, removeAbort: () => signal?.removeEventListener("abort", abort) };
			const waiters = this.waiters.get(uri) ?? new Set<Waiter>();
			waiters.add(waiter);
			this.waiters.set(uri, waiters);
			if (signal?.aborted) abort();
		});
		return {
			outcome,
			cancel: () =>
				this.settle(uri, waiter, {
					status: "unavailable",
					serverId,
					unavailableKind: "aborted",
					reason: "diagnostics cancelled",
				}),
		};
	}

	private onNotification(notification: LspNotification): void {
		const publish = parsePublish(notification);
		if (!publish) return;
		const waiters = this.waiters.get(publish.uri);
		if (!waiters) return;
		for (const waiter of [...waiters]) {
			if (publish.version === undefined || publish.version < waiter.version) continue;
			if (publish.version > waiter.version) {
				this.settle(publish.uri, waiter, {
					status: "unavailable",
					serverId: waiter.serverId,
					unavailableKind: "superseded",
					reason: "diagnostics were superseded by a newer document version",
				});
				continue;
			}
			this.settle(publish.uri, waiter, {
				status: "ok",
				serverId: waiter.serverId,
				diagnostics: publish.diagnostics.slice(0, MAX_DIAGNOSTICS),
				truncated: publish.diagnostics.length > MAX_DIAGNOSTICS,
			});
		}
	}

	private settle(uri: string, waiter: Waiter, outcome: DiagnosticsOutcome): void {
		const waiters = this.waiters.get(uri);
		if (!waiters?.delete(waiter)) return;
		if (waiters.size === 0) this.waiters.delete(uri);
		clearTimeout(waiter.timer);
		waiter.removeAbort();
		waiter.resolve(outcome);
	}
}
