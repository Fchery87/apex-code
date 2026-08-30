import { Box, type Component, Container, getCapabilities, Image, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import type { ToolDefinition, ToolRenderContext } from "../../../core/extensions/types.ts";
import type { ApexToolDefinition } from "../../../core/tools/contract.ts";
import { createAllToolDefinitions, type ToolName } from "../../../core/tools/index.ts";
import { getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.ts";
import { convertToPng } from "../../../utils/image-convert.ts";
import { theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";
import {
	type ToolLifecycle,
	ToolPanelComponent,
	ToolStatusLineComponent,
	type ToolSymbolPreset,
} from "./tool-panel.ts";

const COLLAPSED_ERROR_VISUAL_LINE_LIMIT = 3;

const FALLBACK_PREVIEW_LINES = 10;

export interface ToolExecutionOptions {
	showImages?: boolean;
	imageWidthCells?: number;
	symbolPreset?: ToolSymbolPreset;
}

export class ToolExecutionComponent extends Container {
	private contentBox: Box;
	private contentText: Text;
	private selfRenderContainer: Container;
	private callRendererComponent?: Component;
	private resultRendererComponent?: Component;
	private rendererState: any = {};
	private imageComponents: Image[] = [];
	private imageSpacers: Spacer[] = [];
	private toolName: string;
	private toolCallId: string;
	private args: any;
	private expanded = false;
	private showImages: boolean;
	private imageWidthCells: number;
	private isPartial = true;
	private toolDefinition?: ToolDefinition<any, any> | ApexToolDefinition<any, any>;
	private builtInToolDefinition?: ToolDefinition<any, any> | ApexToolDefinition<any, any>;
	private ui: TUI;
	private cwd: string;
	private executionStarted = false;
	private executionStartedAt?: number;
	private executionEndedAt?: number;
	private elapsedTimer?: ReturnType<typeof setInterval>;
	private argsComplete = false;
	private symbolPreset: ToolSymbolPreset;
	// Composed-line cache. Recomposing the panel (ANSI-aware truncation, width
	// measurement, background paint per content line) on every frame made
	// per-frame cost grow with the number of tools on screen; see
	// test/tool-execution-render-cache.test.ts.
	private displayVersion = 0;
	private cachedRender?: { key: string; width: number; lines: string[] };
	private result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError: boolean;
		details?: any;
	};
	private convertedImages: Map<number, { data: string; mimeType: string }> = new Map();
	private hideComponent = false;

	constructor(
		toolName: string,
		toolCallId: string,
		args: any,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolDefinition<any, any> | ApexToolDefinition<any, any> | undefined,
		ui: TUI,
		cwd: string,
	) {
		super();
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.args = args;
		this.toolDefinition = toolDefinition;
		this.builtInToolDefinition = createAllToolDefinitions(cwd)[toolName as ToolName];
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.symbolPreset = options.symbolPreset ?? "unicode";
		this.ui = ui;
		this.cwd = cwd;

		this.addChild(new Spacer(1));

		// Always create all shell variants. contentBox is used for default renderer-based composition.
		// selfRenderContainer is used when the tool renders its own framing.
		// contentText is reserved for generic fallback rendering when no tool definition exists.
		this.contentBox = new Box(0, 0);
		this.contentText = new Text("", 0, 0);
		this.selfRenderContainer = new Container();

		if (this.hasRendererDefinition()) {
			this.addChild(this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox);
		} else {
			this.addChild(this.contentText);
		}

		this.updateDisplay();
	}

	private getCallRenderer(): ToolDefinition<any, any>["renderCall"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderCall;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderCall;
		}
		return this.toolDefinition.renderCall ?? this.builtInToolDefinition.renderCall;
	}

	private getResultRenderer(): ToolDefinition<any, any>["renderResult"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderResult;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderResult;
		}
		return this.toolDefinition.renderResult ?? this.builtInToolDefinition.renderResult;
	}

	private hasRendererDefinition(): boolean {
		return this.builtInToolDefinition !== undefined || this.toolDefinition !== undefined;
	}

	private getRenderShell(): "default" | "self" {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderShell ?? "default";
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderShell ?? "default";
		}
		return this.toolDefinition.renderShell ?? this.builtInToolDefinition.renderShell ?? "default";
	}

	private getRenderContext(lastComponent: Component | undefined): ToolRenderContext {
		return {
			args: this.args,
			toolCallId: this.toolCallId,
			invalidate: () => {
				this.invalidate();
				this.ui.requestRender();
			},
			lastComponent,
			state: this.rendererState,
			cwd: this.cwd,
			executionStarted: this.executionStarted,
			argsComplete: this.argsComplete,
			isPartial: this.isPartial,
			expanded: this.expanded,
			showImages: this.showImages,
			isError: this.result?.isError ?? false,
		};
	}

	private createCallFallback(): Component {
		return new Text(theme.fg("toolTitle", theme.bold(this.toolName)), 0, 0);
	}

	private createResultFallback(): Component | undefined {
		const output = this.getTextOutput();
		if (!output) {
			return undefined;
		}

		const lines = output.split("\n");
		const displayLines = this.expanded ? lines : lines.slice(0, FALLBACK_PREVIEW_LINES);
		const remaining = lines.length - displayLines.length;
		let text = displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
		return new Text(text, 0, 0);
	}

	updateArgs(args: any): void {
		this.args = args;
		this.updateDisplay();
	}

	markExecutionStarted(): void {
		this.executionStarted = true;
		this.executionStartedAt ??= Date.now();
		this.startElapsedTimer();
		this.updateDisplay();
		this.ui.requestRender();
	}

	setArgsComplete(): void {
		this.argsComplete = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError: boolean;
		},
		isPartial = false,
	): void {
		this.result = result;
		this.isPartial = isPartial;
		if (!isPartial) {
			this.executionEndedAt ??= Date.now();
			this.stopElapsedTimer();
		}
		this.updateDisplay();
		this.maybeConvertImagesForKitty();
	}

	dispose(): void {
		this.stopElapsedTimer();
		this.cachedRender = undefined;
	}

	private startElapsedTimer(): void {
		if (this.elapsedTimer) return;
		this.elapsedTimer = setInterval(() => this.ui.requestRender(), 1000);
	}

	private stopElapsedTimer(): void {
		if (!this.elapsedTimer) return;
		clearInterval(this.elapsedTimer);
		this.elapsedTimer = undefined;
	}

	private maybeConvertImagesForKitty(): void {
		const caps = getCapabilities();
		if (caps.images !== "kitty") return;
		if (!this.result) return;

		const imageBlocks = this.result.content.filter((c) => c.type === "image");
		for (let i = 0; i < imageBlocks.length; i++) {
			const img = imageBlocks[i];
			if (!img.data || !img.mimeType) continue;
			if (img.mimeType === "image/png") continue;
			if (this.convertedImages.has(i)) continue;

			const index = i;
			convertToPng(img.data, img.mimeType).then((converted) => {
				if (converted) {
					this.convertedImages.set(index, converted);
					this.updateDisplay();
					this.ui.requestRender();
				}
			});
		}
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		this.updateDisplay();
	}

	setImageWidthCells(width: number): void {
		this.imageWidthCells = Math.max(1, Math.floor(width));
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private getLifecycle(): ToolLifecycle {
		if (this.result && !this.isPartial) return this.result.isError ? "error" : "done";
		return this.executionStarted ? "running" : "queued";
	}

	private getDurationMs(): number | undefined {
		if (this.executionStartedAt === undefined) return undefined;
		return (this.executionEndedAt ?? Date.now()) - this.executionStartedAt;
	}

	private renderWithStatus(component: Component, width: number): string[] {
		const options = {
			lifecycle: this.getLifecycle(),
			symbolPreset: this.symbolPreset,
			durationMs: this.getDurationMs(),
		};
		if (this.hasRendererDefinition() && this.getRenderShell() === "self") {
			return new ToolStatusLineComponent(component, options).render(width);
		}
		return new ToolPanelComponent(component, options).render(width);
	}

	private renderDisclosureHint(width: number): string[] {
		if (this.expanded || !this.result || this.isPartial || width <= 0) return [];
		const hint = keyHint("app.tools.expand", "to expand");
		return new Text(hint, 0, 0).render(width);
	}

	private renderCollapsedError(contentLines: string[], width: number): string[] {
		const errorText = this.getTextOutput();
		if (!errorText || contentLines.length === 0) return contentLines;

		const errorLines = new Text(theme.fg("toolOutput", errorText), 0, 0).render(width);
		const previewLines = errorLines.slice(0, COLLAPSED_ERROR_VISUAL_LINE_LIMIT);
		const omittedLines = errorLines.length - previewLines.length;
		if (omittedLines === 0) return [...contentLines.slice(0, 1), ...previewLines];

		return [...contentLines.slice(0, 1), ...previewLines, theme.fg("muted", `${omittedLines} more lines omitted`)];
	}

	override render(width: number): string[] {
		if (this.hideComponent || width <= 0) return [];
		const key = this.renderCacheKey();
		const cached = this.cachedRender;
		if (cached && cached.key === key && cached.width === width) return cached.lines;
		const lines = this.compose(width);
		this.cachedRender = { key, width, lines };
		return lines;
	}

	/**
	 * Cache key for the composed lines. Every state change funnels through
	 * updateDisplay(), which bumps displayVersion; the elapsed readout is the
	 * one input that advances without a state change, so it is bucketed at
	 * 250 ms while running (matching the 1 s elapsed timer's cadence closely
	 * enough that the readout never looks stale, while bounding recomposition
	 * to at most four per second for the one running tool).
	 */
	private renderCacheKey(): string {
		const lifecycle = this.getLifecycle();
		const durationMs = this.getDurationMs();
		const durationKey = lifecycle === "running" ? Math.floor((durationMs ?? 0) / 250) : (durationMs ?? -1);
		return `${this.displayVersion}:${lifecycle}:${durationKey}`;
	}

	private compose(width: number): string[] {
		const shell = this.hasRendererDefinition()
			? this.getRenderShell() === "self"
				? this.selfRenderContainer
				: this.contentBox
			: this.contentText;
		const selfRendered = this.hasRendererDefinition() && this.getRenderShell() === "self";
		const panelContent: Component = selfRendered
			? shell
			: {
					render: (innerWidth: number) => {
						const contentLines = shell.render(innerWidth);
						const visibleLines =
							this.result?.isError && !this.isPartial && !this.expanded
								? this.renderCollapsedError(contentLines, innerWidth)
								: contentLines;
						return [...visibleLines, ...this.renderDisclosureHint(innerWidth)];
					},
					invalidate: () => shell.invalidate?.(),
				};
		const visibleContentLines = this.renderWithStatus(panelContent, width);
		if (visibleContentLines.length === 0 && this.imageComponents.length === 0) return [];

		const lines: string[] = [];
		if (visibleContentLines.length > 0) {
			lines.push("");
			lines.push(...visibleContentLines);
			if (selfRendered) lines.push(...this.renderDisclosureHint(width));
		}
		for (let i = 0; i < this.imageComponents.length; i++) {
			const spacer = this.imageSpacers[i];
			if (spacer) lines.push(...spacer.render(width));
			const imageComponent = this.imageComponents[i];
			if (imageComponent) lines.push(...imageComponent.render(width));
		}
		return lines;
	}

	private updateDisplay(): void {
		this.displayVersion += 1;
		let hasContent = false;
		this.hideComponent = false;
		if (this.hasRendererDefinition()) {
			const renderContainer = this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox;
			renderContainer.clear();

			const callRenderer = this.getCallRenderer();
			if (!callRenderer) {
				renderContainer.addChild(this.createCallFallback());
				hasContent = true;
			} else {
				try {
					const component = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
					this.callRendererComponent = component;
					renderContainer.addChild(component);
					hasContent = true;
				} catch {
					this.callRendererComponent = undefined;
					renderContainer.addChild(this.createCallFallback());
					hasContent = true;
				}
			}

			if (this.result) {
				const resultRenderer = this.getResultRenderer();
				if (!resultRenderer) {
					const component = this.createResultFallback();
					if (component) {
						renderContainer.addChild(component);
						hasContent = true;
					}
				} else {
					try {
						const component = resultRenderer(
							{ content: this.result.content as any, details: this.result.details },
							{ expanded: this.expanded, isPartial: this.isPartial },
							theme,
							this.getRenderContext(this.resultRendererComponent),
						);
						this.resultRendererComponent = component;
						renderContainer.addChild(component);
						hasContent = true;
					} catch {
						this.resultRendererComponent = undefined;
						const component = this.createResultFallback();
						if (component) {
							renderContainer.addChild(component);
							hasContent = true;
						}
					}
				}
			}
		} else {
			this.contentText.setText(this.formatToolExecution());
			hasContent = true;
		}

		for (const img of this.imageComponents) {
			this.removeChild(img);
		}
		this.imageComponents = [];
		for (const spacer of this.imageSpacers) {
			this.removeChild(spacer);
		}
		this.imageSpacers = [];

		if (this.result) {
			const imageBlocks = this.result.content.filter((c) => c.type === "image");
			const caps = getCapabilities();
			for (let i = 0; i < imageBlocks.length; i++) {
				const img = imageBlocks[i];
				if (caps.images && this.showImages && img.data && img.mimeType) {
					const converted = this.convertedImages.get(i);
					const imageData = converted?.data ?? img.data;
					const imageMimeType = converted?.mimeType ?? img.mimeType;
					if (caps.images === "kitty" && imageMimeType !== "image/png") continue;

					const spacer = new Spacer(1);
					this.addChild(spacer);
					this.imageSpacers.push(spacer);
					const imageComponent = new Image(
						imageData,
						imageMimeType,
						{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
						{ maxWidthCells: this.imageWidthCells },
					);
					this.imageComponents.push(imageComponent);
					this.addChild(imageComponent);
				}
			}
		}

		if (this.hasRendererDefinition() && !hasContent && this.imageComponents.length === 0) {
			this.hideComponent = true;
		}
	}

	private getTextOutput(): string {
		return getRenderedTextOutput(this.result, this.showImages);
	}

	private formatToolExecution(): string {
		let text = theme.fg("toolTitle", theme.bold(this.toolName));
		const content = JSON.stringify(this.args, null, 2);
		if (content) {
			text += `\n\n${content}`;
		}
		const output = this.getTextOutput();
		if (output) {
			text += `\n${output}`;
		}
		return text;
	}
}
