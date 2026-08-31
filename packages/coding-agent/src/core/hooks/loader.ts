/**
 * Hook config parsing and runtime assembly. Parsing is strict and fails
 * closed: an invalid `hooks` key throws `HookConfigError` with the offending
 * path, and the session wiring lets that propagate -- a governance entry that
 * silently loads as nothing is a policy hole, so a malformed key refuses to
 * start the session instead (the permission-rule posture: a failed rule load
 * blocks rather than falls open).
 */

import { commandHookHandler } from "./command-handler.ts";
import { httpHookHandler } from "./http-handler.ts";
import { createHookRuntime, type RuntimeHookEntry } from "./runtime.ts";
import {
	HOOK_EVENT_NAMES,
	type HookEventName,
	type HookHandler,
	type HookHandlerConfig,
	type HookRuntime,
	type HooksSettings,
	MAX_HOOK_TIMEOUT_MS,
} from "./types.ts";

export class HookConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HookConfigError";
	}
}

const MATCHER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * V1 matcher grammar: exact tool names joined by `|` or `,` with optional
 * whitespace, mirroring permission-rule matching. Regex matchers are a
 * recorded non-goal -- grammar creep is how config surfaces rot.
 */
export function parseMatcher(matcher: string): (toolName: string) => boolean {
	const names = matcher
		.split(/[|,]/)
		.map((name) => name.trim())
		.filter((name) => name.length > 0);
	if (names.length === 0 || !names.every((name) => MATCHER_NAME_PATTERN.test(name))) {
		throw new HookConfigError(`invalid matcher "${matcher}" (expected exact tool names joined by "|" or ",")`);
	}
	const accepted = new Set(names);
	return (toolName) => accepted.has(toolName);
}

function parseHandlerConfig(event: HookEventName, index: number, raw: unknown): HookHandlerConfig {
	const path = `hooks.${event}[${index}]`;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new HookConfigError(`${path}: expected an object`);
	}
	const record = raw as Record<string, unknown>;
	const type = record.type;
	if (type !== "command" && type !== "http") {
		throw new HookConfigError(`${path}: "type" must be "command" or "http"`);
	}
	const allowed =
		type === "command" ? ["type", "matcher", "command", "timeoutMs"] : ["type", "matcher", "url", "timeoutMs"];
	for (const key of Object.keys(record)) {
		if (!allowed.includes(key)) {
			throw new HookConfigError(`${path}: unknown field "${key}" (a mistyped key would silently drop policy)`);
		}
	}
	const matcherField = record.matcher;
	if (matcherField !== undefined) {
		if (typeof matcherField !== "string") {
			throw new HookConfigError(`${path}: "matcher" must be a string`);
		}
		// Validate the grammar here, at load, so a bad matcher is rejected with
		// the config path even before any runtime is assembled.
		parseMatcher(matcherField);
	}
	const timeoutField = record.timeoutMs;
	if (
		timeoutField !== undefined &&
		(typeof timeoutField !== "number" ||
			!Number.isFinite(timeoutField) ||
			timeoutField <= 0 ||
			timeoutField > MAX_HOOK_TIMEOUT_MS)
	) {
		throw new HookConfigError(`${path}: "timeoutMs" must be a number between 1 and ${MAX_HOOK_TIMEOUT_MS}`);
	}
	if (type === "command") {
		const command = record.command;
		if (typeof command !== "string" || command.trim().length === 0) {
			throw new HookConfigError(`${path}: "command" must be a non-empty string`);
		}
		return {
			type: "command",
			command,
			...(matcherField !== undefined ? { matcher: matcherField } : {}),
			...(timeoutField !== undefined ? { timeoutMs: timeoutField } : {}),
		};
	}
	const urlField = record.url;
	if (typeof urlField !== "string" || !URL.canParse(urlField) || !/^https?:$/.test(new URL(urlField).protocol)) {
		throw new HookConfigError(`${path}: "url" must be an http(s) URL`);
	}
	return {
		type: "http",
		url: urlField,
		...(matcherField !== undefined ? { matcher: matcherField } : {}),
		...(timeoutField !== undefined ? { timeoutMs: timeoutField } : {}),
	};
}

/** Strictly validate raw settings JSON into `HooksSettings`, throwing `HookConfigError` on the first problem. */
export function parseHookSettings(raw: unknown): HooksSettings {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new HookConfigError("hooks: expected an object keyed by event name");
	}
	const parsed: HooksSettings = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!(HOOK_EVENT_NAMES as readonly string[]).includes(key)) {
			throw new HookConfigError(`hooks."${key}": unknown hook event (v1 supports ${HOOK_EVENT_NAMES.join(", ")})`);
		}
		const event = key as HookEventName;
		if (!Array.isArray(value)) {
			throw new HookConfigError(`hooks.${event}: expected an array of handler configs`);
		}
		parsed[event] = value.map((entry, index) => parseHandlerConfig(event, index, entry));
	}
	return parsed;
}

export type HookHandlerFactory = (config: HookHandlerConfig, event: HookEventName) => HookHandler;

function defaultHookHandlerFactory(config: HookHandlerConfig): HookHandler {
	return config.type === "command" ? commandHookHandler(config) : httpHookHandler(config);
}

/**
 * Assemble the runtime, or return undefined when nothing is configured -- an
 * absent key constructs nothing, so an unconfigured session spawns no
 * subprocess and changes no behavior. `createHandler` is the seam tests use to
 * inject scripted handlers instead of real command/HTTP execution.
 */
export function loadHookRuntime(
	settings: HooksSettings | undefined,
	createHandler: HookHandlerFactory = defaultHookHandlerFactory,
): HookRuntime | undefined {
	if (!settings) return undefined;
	const entries: RuntimeHookEntry[] = [];
	for (const event of HOOK_EVENT_NAMES) {
		const configs = settings[event];
		if (!configs || configs.length === 0) continue;
		for (const config of configs) {
			const handler = createHandler(config, event);
			entries.push({
				event,
				handler: config.matcher ? { ...handler, matchesTool: parseMatcher(config.matcher) } : handler,
			});
		}
	}
	if (entries.length === 0) return undefined;
	return createHookRuntime(entries);
}
