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
		...(options.lsp ? ["lsp"] : []),
		...(options.webSearch ? ["web_search"] : []),
		...(options.mcp ? ["mcp"] : []),
	];
}
