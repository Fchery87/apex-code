import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type { InputSource } from "../../core/extensions/types.ts";
import { takeOverStdout } from "../../core/output-guard.ts";
import type { PermissionAnswer } from "../../core/permissions/responder.ts";
import { attachJsonlLineReader, serializeJsonLine } from "../rpc/jsonl.ts";
import { translateJsonEvent } from "./translate.ts";

/**
 * The ACP server (spec 2026-08-31-acp-adapter.md): an in-process ACP v1 agent
 * over newline-delimited JSON-RPC on stdio. The host adapters between the
 * protocol and the live AgentSession; the server never imports session types,
 * so tests drive it entirely through fakes.
 */

/** The slice of AgentSession the protocol actually drives. */
export interface AcpPromptableSession {
	prompt(text: string, options: { source: InputSource }): Promise<unknown>;
	abort(): Promise<void> | void;
}

export interface AcpHost {
	getSession(): AcpPromptableSession;
	createSession(cwd: string): Promise<AcpPromptableSession>;
	loadSession(sessionId: string, cwd: string): Promise<AcpPromptableSession>;
	setMode?(mode: string): Promise<void> | void;
}

const PERMISSION_OPTIONS = [
	{ optionId: "allow-once", name: "Allow once", kind: "allow_once" },
	{ optionId: "allow-always", name: "Always allow", kind: "allow_always" },
	{ optionId: "reject-once", name: "Reject", kind: "reject_once" },
	{ optionId: "reject-always", name: "Reject always", kind: "reject_always" },
] as const;

export class AcpServer {
	readonly #input: Readable;
	readonly #output: Writable;
	readonly #host: AcpHost;
	readonly #pendingPermissions = new Map<string, (answer: PermissionAnswer) => void>();
	readonly #seenToolCalls = new Set<string>();
	#currentSessionId: string | undefined;

	constructor(deps: { input: Readable; output: Writable; host: AcpHost }) {
		this.#input = deps.input;
		this.#output = deps.output;
		this.#host = deps.host;
	}

	start(): void {
		attachJsonlLineReader(this.#input, (line) => this.handleLine(line));
	}

	get currentSessionId(): string | undefined {
		return this.#currentSessionId;
	}

	handleLine(line: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			// ACP is line-delimited JSON; anything else on the wire is dropped, not fatal.
			return;
		}
		if (typeof parsed !== "object" || parsed === null) return;
		const message = parsed as Record<string, unknown>;
		const { id, method, params } = message;

		if (typeof method !== "string") {
			// No method: a response to one of our server->client requests (permission).
			if (id !== undefined) this.#resolvePermission(String(id), message.result);
			return;
		}
		if (id === undefined) {
			if (method === "session/cancel") {
				void this.#host.getSession().abort();
			}
			return;
		}
		void this.#dispatch(id, method, params);
	}

	/** Entry point for live session events; translates and emits session/update. */
	onSessionEvent(event: unknown): void {
		if (this.#currentSessionId === undefined) return;
		const translated = translateJsonEvent(event);
		if (!translated) return;
		if (translated.kind === "message") {
			this.#notify(this.#currentSessionId, translated.update);
			return;
		}
		const seen = this.#seenToolCalls.has(translated.toolCallId);
		this.#seenToolCalls.add(translated.toolCallId);
		this.#notify(this.#currentSessionId, {
			sessionUpdate: seen ? "tool_call_update" : "tool_call",
			...translated.update,
		});
	}

	/**
	 * The PermissionResponder bridge: turns one ACP permission round trip into
	 * the gate's answer shape. Rule persistence itself stays in the gate
	 * (ADR 0010) -- `persist` is a request, not a written rule.
	 */
	askPermission(sessionId: string, toolName: string, description: string): Promise<PermissionAnswer> {
		const id = `perm_${randomUUID()}`;
		return new Promise<PermissionAnswer>((resolve) => {
			this.#pendingPermissions.set(id, resolve);
			this.#write({
				jsonrpc: "2.0",
				id,
				method: "session/request_permission",
				params: {
					sessionId,
					toolCall: { toolCallId: id, title: `${toolName}: ${description}`, kind: "other", status: "pending" },
					options: PERMISSION_OPTIONS,
				},
			});
		});
	}

	#write(value: unknown): void {
		this.#output.write(serializeJsonLine(value));
	}

	#notify(sessionId: string, update: Record<string, unknown>): void {
		this.#write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
	}

	#resolvePermission(id: string, result: unknown): void {
		const resolve = this.#pendingPermissions.get(id);
		if (!resolve) return;
		this.#pendingPermissions.delete(id);
		const outcome = (result as { outcome?: { outcome?: string; optionId?: string } } | undefined)?.outcome;
		if (outcome?.outcome !== "selected" || typeof outcome.optionId !== "string") {
			// Cancelled, malformed, or unknown -- fail closed.
			resolve({ allow: false });
			return;
		}
		if (outcome.optionId.startsWith("allow")) {
			resolve({ allow: true, persist: outcome.optionId === "allow-always" });
			return;
		}
		resolve({ allow: false, persist: outcome.optionId === "reject-always" });
	}

	async #dispatch(id: unknown, method: string, params: unknown): Promise<void> {
		const record = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
		try {
			switch (method) {
				case "initialize": {
					this.#write({
						jsonrpc: "2.0",
						id,
						result: {
							protocolVersion: 1,
							agentCapabilities: { loadSession: true },
							promptCapabilities: { image: false, audio: false, embeddedContext: false },
							agentInfo: { name: "apex-code", title: "Apex Code" },
							authMethods: [],
						},
					});
					return;
				}
				case "session/new": {
					const cwd = typeof record.cwd === "string" ? record.cwd : process.cwd();
					// The host rebinds its live session; the returned session is driven
					// through host.getSession() afterwards.
					await this.#host.createSession(cwd);
					this.#currentSessionId = `sess_${randomUUID()}`;
					this.#seenToolCalls.clear();
					this.#write({ jsonrpc: "2.0", id, result: { sessionId: this.#currentSessionId } });
					return;
				}
				case "session/load": {
					const sessionId = typeof record.sessionId === "string" ? record.sessionId : "";
					const cwd = typeof record.cwd === "string" ? record.cwd : process.cwd();
					await this.#host.loadSession(sessionId, cwd);
					this.#currentSessionId = sessionId;
					this.#seenToolCalls.clear();
					// History replay is deferred (plan, ACP.2): the session reattaches
					// and continues, but prior entries are not streamed in v1.
					this.#write({ jsonrpc: "2.0", id, result: null });
					return;
				}
				case "session/prompt": {
					if (this.#currentSessionId === undefined || record.sessionId !== this.#currentSessionId) {
						this.#write({
							jsonrpc: "2.0",
							id,
							error: { code: -32002, message: "Unknown session; call session/new first" },
						});
						return;
					}
					const prompt = Array.isArray(record.prompt) ? record.prompt : [];
					const text = prompt
						.filter((block): block is { type: "text"; text: string } => {
							const candidate = block as { type?: string; text?: string };
							return candidate.type === "text" && typeof candidate.text === "string";
						})
						.map((block) => block.text)
						.join("\n");
					try {
						await this.#host.getSession().prompt(text, { source: "acp" });
						this.#write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
					} catch (error) {
						const messageText = error instanceof Error ? error.message : String(error);
						if (/abort/i.test(messageText)) {
							this.#write({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } });
							return;
						}
						throw error;
					}
					return;
				}
				case "session/set_mode": {
					const mode = typeof record.mode === "string" ? record.mode : "";
					await this.#host.setMode?.(mode);
					this.#write({ jsonrpc: "2.0", id, result: {} });
					return;
				}
				default:
					this.#write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
			}
		} catch (error) {
			this.#write({
				jsonrpc: "2.0",
				id,
				error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
			});
		}
	}
}

/**
 * Run in ACP mode: ACP v1 agent over stdio for the runtime's session. ACP owns
 * stdout from here on (output guard takes it over).
 */
export async function runAcpMode(runtime: AgentSessionRuntime, bridge?: { current?: AcpServer }): Promise<never> {
	takeOverStdout();
	const host: AcpHost = {
		getSession: () => runtime.session,
		createSession: async () => {
			await runtime.newSession();
			return runtime.session;
		},
		loadSession: async () => runtime.session,
		setMode: async (mode) => {
			await runtime.session.setPermissionMode(mode as Parameters<typeof runtime.session.setPermissionMode>[0]);
		},
	};
	const server = new AcpServer({ input: process.stdin, output: process.stdout, host });
	if (bridge) bridge.current = server;
	runtime.session.subscribe((event) => server.onSessionEvent(event));
	server.start();
	// The ACP connection owns the process lifetime; it ends when stdin closes.
	return new Promise(() => {});
}
