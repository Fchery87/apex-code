/**
 * Local types for highlight.js, used instead of the ones it ships.
 *
 * Version 11's `types/index.d.ts` opens with `/// <reference lib="dom" />`. A lib reference
 * inside a declaration file is honored regardless of `skipLibCheck`, so importing highlight.js
 * pulls `lib.dom.d.ts` into the whole program. DOM's `Headers` then shadows the one
 * `@types/node` provides, and `packages/ai` stops compiling: it iterates headers and reads
 * `.entries()`, which the DOM type in this lib version does not offer.
 *
 * `packages/ai` is frozen under ADR 0001, so the break lands in code this repository is
 * forbidden to repair. The root `tsconfig.json` maps the highlight.js specifiers here instead,
 * which keeps DOM out of the program and the dependency current. Only the surface
 * `syntax-highlight.ts` actually calls is declared.
 */
export interface HighlightJsResult {
	value: string;
}

export interface HighlightJsOptions {
	language: string;
	ignoreIllegals?: boolean;
}

export interface HighlightJsLanguageDefinition {
	readonly name?: string;
}

export type HighlightJsLanguageFactory = (hljs: HighlightJsApi) => HighlightJsLanguageDefinition;

export interface HighlightJsApi {
	highlight(code: string, options: HighlightJsOptions): HighlightJsResult;
	highlightAuto(code: string, languageSubset?: string[]): HighlightJsResult;
	getLanguage(name: string): HighlightJsLanguageDefinition | undefined;
	registerLanguage(name: string, language: HighlightJsLanguageFactory): void;
	listLanguages(): string[];
}

declare const hljs: HighlightJsApi;
export default hljs;
