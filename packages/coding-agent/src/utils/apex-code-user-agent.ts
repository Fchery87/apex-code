export function getApexCodeUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `apex-code/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}
