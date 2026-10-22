const UNKNOWN_PROVIDER = "unknown";

export function getProviderLoginHelp(): string {
	return "Provider setup is documented in providers.md and models.md, under the Apex Code docs directory.";
}

export function formatNoModelsAvailableMessage(): string {
	return `No models available. Run /login to connect a provider.\n\n${getProviderLoginHelp()}`;
}

export function formatNoModelSelectedMessage(): string {
	return `No model selected. Run /login to connect a provider, then /model to choose one.\n\n${getProviderLoginHelp()}`;
}

export function formatNoApiKeyFoundMessage(provider: string): string {
	const providerDisplay = provider === UNKNOWN_PROVIDER ? "the selected model" : provider;
	return `No API key found for ${providerDisplay}. Run /login to connect one.\n\n${getProviderLoginHelp()}`;
}
