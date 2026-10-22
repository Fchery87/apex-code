import type { ImageContent, TextContent } from "@earendil-works/pi-ai/compat";
import type { AgentToolResult } from "apex-code-agent-core";
import { minimatch } from "minimatch";
import { type Static, Type } from "typebox";
import { browserDestinationRefusal } from "./browser-destination.ts";
import type { ApexToolDefinition } from "./contract.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const browserSchema = Type.Object({
	url: Type.String({ description: "Absolute http(s) URL on localhost, 127.0.0.1, or ::1." }),
});

export type BrowserInput = Static<typeof browserSchema>;

export interface BrowserPage {
	title: string;
	finalUrl: string;
	console: string[];
	screenshot?: Uint8Array;
}

export interface BrowserOperations {
	open(url: string, signal?: AbortSignal): Promise<BrowserPage>;
}

export interface BrowserDetails {
	url: string;
	opened: boolean;
	consoleLines: number;
}

export interface BrowserToolOptions {
	operations: BrowserOperations;
}

const MAX_CONSOLE_LINES = 50;
const MAX_CONSOLE_CHARS = 8_000;

function hostAndPath(url: string): string {
	const parsed = new URL(url);
	return `${parsed.hostname}${parsed.pathname}`;
}

function consoleText(lines: readonly string[]): string {
	const kept = lines.slice(0, MAX_CONSOLE_LINES);
	let text = kept.join("\n");
	if (text.length > MAX_CONSOLE_CHARS) text = text.slice(0, MAX_CONSOLE_CHARS);
	const omitted = lines.length - kept.length;
	return omitted > 0 ? `${text}\n[${omitted} more console lines omitted]` : text;
}

function textBlock(text: string): TextContent {
	return { type: "text", text };
}

export function createBrowserToolDefinition(
	options: BrowserToolOptions,
): ApexToolDefinition<typeof browserSchema, BrowserDetails> {
	return {
		name: "browser",
		label: "browser",
		description: "Open one loopback URL and return its title, console, and a screenshot.",
		parameters: browserSchema,
		contract: {
			capabilities: new Set(["net"]),
			permission: {
				defaultBehavior: "ask",
				matches: (ruleContent, params) => minimatch(hostAndPath(params.url), ruleContent, { dot: true }),
				describe: (ruleContent) => `Open loopback URLs matching "${ruleContent}"`,
				ruleForCall: (params) => hostAndPath(params.url),
			},
			context: { resultRecoverable: false, deferSchema: true },
			evidence: { emits: new Set(), capture: () => [] },
		},
		async execute(_toolCallId, { url }, signal): Promise<AgentToolResult<BrowserDetails>> {
			const refusal = browserDestinationRefusal(url);
			if (refusal) {
				return {
					content: [textBlock(refusal)],
					details: { url, opened: false, consoleLines: 0 },
				};
			}
			const page = await options.operations.open(url, signal);
			const consoleBody = consoleText(page.console);
			const lines = [
				`Title: ${page.title || "(none)"}`,
				`URL: ${page.finalUrl || url}`,
				consoleBody ? `Console:\n${consoleBody}` : "Console: (empty)",
			];
			const content: Array<TextContent | ImageContent> = [];
			if (!page.screenshot || page.screenshot.byteLength === 0) {
				lines.push("No screenshot was captured.");
				content.push(textBlock(lines.join("\n")));
			} else {
				content.push(textBlock(lines.join("\n")));
				content.push({
					type: "image",
					data: Buffer.from(page.screenshot).toString("base64"),
					mimeType: "image/png",
				});
			}
			return {
				content,
				details: { url, opened: true, consoleLines: page.console.length },
			};
		},
	};
}

export function createBrowserTool(options: BrowserToolOptions) {
	return wrapToolDefinition(createBrowserToolDefinition(options));
}
