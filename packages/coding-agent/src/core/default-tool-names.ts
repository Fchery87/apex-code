/**
 * The tools active in a new session when no `defaultTools` setting or `--tools` list says
 * otherwise. Every name here is also gated by its own permission rule, so being active does
 * not run anything without a decision.
 *
 * `ask_user` is deliberately absent. It needs a UI, and the session cannot tell at
 * construction whether one will be attached, so it stays opt-in until it can.
 * `todo_write` is absent too: the task-list row in /settings (RS.9) opts a user in, and a
 * default would override that deliberate choice.
 */
export function configuredDefaultToolNames(options: {
	baseNames?: readonly string[];
	lsp?: boolean;
	webSearch?: boolean;
	mcp?: boolean;
}): string[] {
	if (options.baseNames) return [...options.baseNames];
	return [
		"read",
		"bash",
		"edit",
		"write",
		"grep",
		"find",
		"ls",
		"web_fetch",
		"delegate",
		...(options.lsp ? ["lsp"] : []),
		...(options.webSearch ? ["web_search"] : []),
		...(options.mcp ? ["mcp"] : []),
	];
}
