import { dirname, join } from "node:path";
import {
	type Api,
	type ApiStreamOptions,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type AuthCheck,
	type AuthInteraction,
	type AuthOperationOptions,
	type AuthResult,
	type AuthType,
	type Context,
	type Credential,
	type CredentialInfo,
	type CredentialStore,
	createAssistantMessageEventStream,
	createModels,
	type DeferredCancelOptions,
	type DeferredFetchOptions,
	type DeferredHandle,
	lazyStream,
	type Model,
	type Models,
	type ModelsApiStreamOptions,
	type ModelsDeferredCancelOptions,
	type ModelsDeferredFetchOptions,
	ModelsError,
	type ModelsRefreshOptions,
	type ModelsRefreshResult,
	type ModelsRequestTransforms,
	type ModelsSimpleStreamOptions,
	type ModelsStore,
	type MutableModels,
	type Provider,
	type ProviderHeaders,
	type ProviderRequestOptions,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import * as builtinProviderCatalog from "@earendil-works/pi-ai/providers/all";
import { getAgentDir } from "../config.ts";
import { operationSignal, raceWithAbortSignal } from "../utils/abort.ts";
import { AuthStorage as DefaultAuthStorage } from "./auth-storage.ts";
import {
	classifyCredentialFailure,
	type DrainedAttempt,
	drainAttempt,
	type ResultStream,
	replayAttempt,
} from "./credential-failover.ts";
import type { CredentialFailureKind, CredentialIdentity, CredentialPool } from "./credential-pool.ts";
import { getApexEnvironment } from "./environment.ts";
import { ModelConfig } from "./model-config.ts";
import { type RoleResolutionResult, resolveModelRoles } from "./model-resolver.ts";
import { FileModelsStore, InMemoryCodingAgentModelsStore } from "./models-store.ts";
import { exportUsageSampleSpan, type OtlpExportConfig } from "./observability/otlp.ts";
import {
	type AuthStatus,
	type CompatibilityRequestConfig,
	composeModelProvider,
	configuredRequestAuthStatus,
	type ProviderConfigInput,
	resolveCompatibilityRequestConfig,
	resolveConfiguredModelHeaders,
	validateExtensionProvider,
} from "./provider-composer.ts";
import { withRemoteCatalog } from "./remote-catalog-provider.ts";
import { RuntimeCredentials } from "./runtime-credentials.ts";
import type { UsagePerformanceSample, UsagePerformanceStore } from "./usage-performance-store.ts";

interface ModelRuntimeSnapshot {
	all: readonly Model<Api>[];
	available: readonly Model<Api>[];
	configuredProviders: ReadonlySet<string>;
	storedProviders: ReadonlySet<string>;
	auth: ReadonlyMap<string, AuthCheck | undefined>;
}

export interface CreateModelRuntimeOptions {
	/** Credential storage. Defaults to the file at authPath. */
	credentials?: CredentialStore;
	authPath?: string;
	modelsPath?: string | null;
	modelsStore?: ModelsStore;
	modelsStorePath?: string;
	/** Allow create() to refresh model catalogs over the network. Defaults to false. */
	allowModelNetwork?: boolean;
	/** Timeout for the create-time network model refresh. */
	modelRefreshTimeoutMs?: number;
	catalogBaseUrl?: string;
	/** Optional caller cancellation for initial cache restoration and availability checks. */
	signal?: AbortSignal;
	/** Skip initial catalog and availability refresh. Static models remain available. */
	refreshOnCreate?: boolean;
	/**
	 * Optional pool for bounded, pre-completion credential failover in streamSimple().
	 * Providers with no entries in the pool keep single-credential auth resolution
	 * unchanged. Apex owns this pool adjacent to the consumed CredentialStore
	 * contract (one credential per provider); it is never itself a CredentialStore.
	 */
	credentialPool?: CredentialPool;
	/**
	 * Resolves the request-scoped auth override for a credential-pool selection.
	 * Required for pool entries to actually authenticate; an identity with no
	 * resolver entry falls back to the request's own apiKey/env options.
	 */
	resolveCredentialPoolAuth?: (
		identity: CredentialIdentity,
	) => { apiKey?: string; env?: Record<string, string> } | undefined;
	/** Optional durable store for non-secret per-request usage/latency samples. Unset records nothing. */
	usagePerformanceStore?: UsagePerformanceStore;
	/** Monotonic clock for usage/latency timing. Defaults to performance.now(); inject a fake in tests. */
	performanceClock?: () => number;
	/** User-directed OTLP export target (roadmap Phase 8, ADR 0012). Unset: no export, no egress. */
	otlpExportConfig?: OtlpExportConfig;
}

export interface ModelRuntimeAuthOverrides extends AuthOperationOptions {
	apiKey?: string;
	env?: Record<string, string>;
	/** Require this much remaining OAuth-token validity; defaults to five minutes. */
	minOAuthValidityMs?: number;
}

export type CredentialSynchronizationOperation = "login" | "logout" | "setRuntimeApiKey" | "removeRuntimeApiKey";

/** Credentials changed successfully, but the local model/auth snapshot could not be synchronized. */
export class CredentialSynchronizationError extends Error {
	readonly providerId: string;
	readonly operation: CredentialSynchronizationOperation;
	readonly credential: Credential | undefined;

	constructor(
		providerId: string,
		operation: CredentialSynchronizationOperation,
		credential: Credential | undefined,
		options: ErrorOptions,
	) {
		super(`Credential ${operation} committed for ${providerId}, but local synchronization failed`, options);
		this.name = "CredentialSynchronizationError";
		this.providerId = providerId;
		this.operation = operation;
		this.credential = credential;
	}
}

function mergeHeaders(
	base: ProviderHeaders | undefined,
	override: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
	if (!base && !override) return undefined;
	const merged = { ...base };
	for (const [name, value] of Object.entries(override ?? {})) {
		const lowerName = name.toLowerCase();
		for (const existingName of Object.keys(merged)) {
			if (existingName.toLowerCase() === lowerName) delete merged[existingName];
		}
		merged[name] = value;
	}
	return merged;
}

/** Configured pi-ai Models collection used by coding-agent and SDK consumers. */
export class ModelRuntime implements Models {
	private readonly models: MutableModels;
	private readonly credentials: RuntimeCredentials;
	private readonly defaultBuiltins: ReadonlyMap<string, Provider>;
	private readonly builtins = new Map<string, Provider>();
	private readonly nativeExtensionProviders = new Map<string, Provider>();
	private readonly extensionProviders = new Map<string, ProviderConfigInput>();
	private readonly compositionErrors = new Map<string, string>();
	private readonly modelsPath: string | undefined;
	private readonly modelNetworkEnabled: boolean;
	private config: ModelConfig;
	private snapshot: ModelRuntimeSnapshot = {
		all: [],
		available: [],
		configuredProviders: new Set(),
		storedProviders: new Set(),
		auth: new Map(),
	};
	private availabilityRefreshSeq = 0;
	private availabilityErrorSeq = 0;
	private readonly providerAvailabilitySeq = new Map<string, number>();
	private availabilityError: string | undefined;
	private readonly credentialOperations = new Map<string, Promise<unknown>>();
	private readonly credentialPool: CredentialPool | undefined;
	private readonly resolveCredentialPoolAuth:
		| ((identity: CredentialIdentity) => { apiKey?: string; env?: Record<string, string> } | undefined)
		| undefined;
	private readonly usagePerformanceStore: UsagePerformanceStore | undefined;
	private readonly performanceClock: () => number;
	private readonly otlpExportConfig: OtlpExportConfig | undefined;

	private constructor(
		credentials: RuntimeCredentials,
		config: ModelConfig,
		modelsPath: string | undefined,
		modelsStore: ModelsStore,
		providers: readonly Provider[],
		modelNetworkEnabled: boolean,
		credentialPool?: CredentialPool,
		resolveCredentialPoolAuth?: (
			identity: CredentialIdentity,
		) => { apiKey?: string; env?: Record<string, string> } | undefined,
		usagePerformanceStore?: UsagePerformanceStore,
		performanceClock?: () => number,
		otlpExportConfig?: OtlpExportConfig,
	) {
		this.credentials = credentials;
		this.config = config;
		this.modelsPath = modelsPath;
		this.modelNetworkEnabled = modelNetworkEnabled;
		this.credentialPool = credentialPool;
		this.resolveCredentialPoolAuth = resolveCredentialPoolAuth;
		this.usagePerformanceStore = usagePerformanceStore;
		this.performanceClock = performanceClock ?? (() => performance.now());
		this.otlpExportConfig = otlpExportConfig;
		this.defaultBuiltins = new Map(providers.map((provider) => [provider.id, provider]));
		for (const [providerId, provider] of this.defaultBuiltins) this.builtins.set(providerId, provider);
		this.models = createModels({ credentials, modelsStore });
		this.rebuildProviders();
	}

	static async create(options: CreateModelRuntimeOptions = {}): Promise<ModelRuntime> {
		const credentials = new RuntimeCredentials(options.credentials ?? DefaultAuthStorage.create(options.authPath));
		const modelsPath =
			options.modelsPath === null ? undefined : (options.modelsPath ?? join(getAgentDir(), "models.json"));
		const config = await ModelConfig.load(modelsPath);
		const modelsStore =
			options.modelsStore ??
			(modelsPath
				? new FileModelsStore(options.modelsStorePath ?? join(dirname(modelsPath), "models-store.json"))
				: new InMemoryCodingAgentModelsStore());
		const builtinModelDataGeneratedAt = builtinProviderCatalog.getBuiltinModelDataGeneratedAt();
		const providers = builtinProviderCatalog
			.builtinProviders()
			.map((provider) =>
				provider.id === "radius"
					? provider
					: withRemoteCatalog(provider, options.catalogBaseUrl, builtinModelDataGeneratedAt),
			);
		const runtime = new ModelRuntime(
			credentials,
			config,
			modelsPath,
			modelsStore,
			providers,
			getApexEnvironment("APEX_CODE_OFFLINE") === undefined,
			options.credentialPool,
			options.resolveCredentialPoolAuth,
			options.usagePerformanceStore,
			options.performanceClock,
			options.otlpExportConfig,
		);
		runtime.configureRadiusProviders();
		runtime.rebuildProviders();
		const refreshFromNetwork = runtime.modelNetworkEnabled && options.allowModelNetwork === true;
		const controller =
			refreshFromNetwork && options.modelRefreshTimeoutMs !== undefined ? new AbortController() : undefined;
		const timeout = controller ? setTimeout(() => controller.abort(), options.modelRefreshTimeoutMs) : undefined;
		const signal = controller
			? options.signal
				? AbortSignal.any([options.signal, controller.signal])
				: controller.signal
			: options.signal;
		try {
			if (options.refreshOnCreate !== false) {
				await runtime.refresh({ allowNetwork: refreshFromNetwork, signal });
			}
		} finally {
			if (timeout) clearTimeout(timeout);
		}
		return runtime;
	}

	private configureRadiusProviders(): void {
		this.builtins.clear();
		for (const [providerId, provider] of this.defaultBuiltins) this.builtins.set(providerId, provider);
		for (const providerId of this.config.getProviderIds()) {
			const config = this.config.getProvider(providerId);
			if (config?.oauth !== "radius" || !config.baseUrl) continue;
			this.builtins.set(
				providerId,
				builtinProviderCatalog.radiusProvider({
					id: providerId,
					name: config.name ?? providerId,
					gateway: config.baseUrl.replace(/\/v1\/?$/u, ""),
				}),
			);
		}
	}

	private providerIds(): Set<string> {
		return new Set([
			...this.builtins.keys(),
			...this.nativeExtensionProviders.keys(),
			...this.config.getProviderIds(),
			...this.extensionProviders.keys(),
		]);
	}

	private recomposeProvider(providerId: string): void {
		const base = this.nativeExtensionProviders.get(providerId) ?? this.builtins.get(providerId);
		const extension = this.extensionProviders.get(providerId);
		if (!base && !this.config.getProvider(providerId) && !extension) {
			this.models.deleteProvider(providerId);
			this.compositionErrors.delete(providerId);
			return;
		}
		if (base && !this.config.getProvider(providerId) && !extension) {
			// No overlays: use the builtin untouched so its auth/login/stream behavior is exact.
			this.models.setProvider(base);
			this.compositionErrors.delete(providerId);
			return;
		}
		try {
			this.models.setProvider(composeModelProvider(providerId, base, this.config, extension));
			this.compositionErrors.delete(providerId);
		} catch (error) {
			this.compositionErrors.set(providerId, error instanceof Error ? error.message : String(error));
			if (base) this.models.setProvider(base);
			else this.models.deleteProvider(providerId);
		}
	}

	private rebuildProviders(): void {
		this.models.clearProviders();
		this.compositionErrors.clear();
		for (const providerId of this.providerIds()) this.recomposeProvider(providerId);
		this.updateModelSnapshot();
	}

	private updateModelSnapshot(): void {
		const all = [...this.models.getModels()];
		this.snapshot = {
			...this.snapshot,
			all,
			available: all.filter((model) => this.snapshot.configuredProviders.has(model.provider)),
		};
	}

	private async runAvailabilityRefresh(seq: number, errorSeq: number, signal: AbortSignal): Promise<void> {
		const providers = this.models.getProviders();
		const [available, checks, credentials] = await Promise.all([
			this.models.getAvailable(undefined, { signal }),
			Promise.all(
				providers.map(
					async (provider): Promise<[string, AuthCheck | undefined]> => [
						provider.id,
						await this.models.checkAuth(provider.id, { signal }),
					],
				),
			),
			this.credentials.list({ signal }),
		]);
		if (seq !== this.availabilityRefreshSeq) return;
		const auth = new Map(checks);
		const configuredProviders = new Set(
			checks
				.filter((entry): entry is [string, AuthCheck] => entry[1] !== undefined)
				.map(([providerId]) => providerId),
		);
		this.snapshot = {
			all: [...this.models.getModels()],
			available: [...available],
			configuredProviders,
			storedProviders: new Set(credentials.map((entry) => entry.providerId)),
			auth,
		};
		if (errorSeq === this.availabilityErrorSeq) this.availabilityError = undefined;
	}

	private queueAvailabilityRefresh(signal?: AbortSignal): Promise<void> {
		const seq = ++this.availabilityRefreshSeq;
		for (const [providerId, providerSeq] of this.providerAvailabilitySeq) {
			this.providerAvailabilitySeq.set(providerId, providerSeq + 1);
		}
		const errorSeq = ++this.availabilityErrorSeq;
		const effectiveSignal = operationSignal(signal);
		return this.runAvailabilityRefresh(seq, errorSeq, effectiveSignal).catch((error) => {
			if (errorSeq === this.availabilityErrorSeq && !effectiveSignal.aborted) {
				this.availabilityError = error instanceof Error ? error.message : String(error);
			}
			throw error;
		});
	}

	private async refreshProviderAvailability(providerId: string, signal: AbortSignal): Promise<void> {
		// Invalidate any full availability pass that started before this credential change.
		++this.availabilityRefreshSeq;
		const providerSeq = (this.providerAvailabilitySeq.get(providerId) ?? 0) + 1;
		this.providerAvailabilitySeq.set(providerId, providerSeq);
		const errorSeq = ++this.availabilityErrorSeq;
		try {
			const [available, auth, credential] = await Promise.all([
				this.models.getAvailable(providerId, { signal }),
				this.models.checkAuth(providerId, { signal }),
				this.credentials.read(providerId, { signal }),
			]);
			signal.throwIfAborted();
			if (this.providerAvailabilitySeq.get(providerId) !== providerSeq) return;
			const configuredProviders = new Set(this.snapshot.configuredProviders);
			const storedProviders = new Set(this.snapshot.storedProviders);
			const authByProvider = new Map(this.snapshot.auth);
			if (auth) {
				configuredProviders.add(providerId);
				authByProvider.set(providerId, auth);
			} else {
				configuredProviders.delete(providerId);
				authByProvider.delete(providerId);
			}
			if (credential) storedProviders.add(providerId);
			else storedProviders.delete(providerId);
			const all = [...this.models.getModels()];
			const availableById = new Map(
				[...this.snapshot.available.filter((model) => model.provider !== providerId), ...available].map((model) => [
					`${model.provider}\0${model.id}`,
					model,
				]),
			);
			this.snapshot = {
				all,
				available: all.flatMap((model) => availableById.get(`${model.provider}\0${model.id}`) ?? []),
				configuredProviders,
				storedProviders,
				auth: authByProvider,
			};
			if (errorSeq === this.availabilityErrorSeq) this.availabilityError = undefined;
		} catch (error) {
			if (
				this.providerAvailabilitySeq.get(providerId) === providerSeq &&
				errorSeq === this.availabilityErrorSeq &&
				!signal.aborted
			) {
				this.availabilityError = error instanceof Error ? error.message : String(error);
			}
			throw error;
		}
	}

	getProviders(): readonly Provider[] {
		return this.models.getProviders();
	}

	getProvider(providerId: string): Provider | undefined {
		return this.models.getProvider(providerId);
	}

	getModels(providerId?: string): readonly Model<Api>[] {
		return this.models.getModels(providerId);
	}

	getModel(providerId: string, modelId: string): Model<Api> | undefined {
		return this.models.getModel(providerId, modelId);
	}

	/**
	 * Resolve additive role configuration into ordered model-candidate chains.
	 * Credential-blind and side-effect free: it never resolves auth and never
	 * writes configuration. Legacy files with no `roles` resolve to an empty map,
	 * leaving initial model selection (`findInitialModel`, `resolveCliModel`)
	 * behaviorally unchanged.
	 */
	resolveModelRoles(): RoleResolutionResult {
		return resolveModelRoles(this.config.getRoles(), this.getModels());
	}

	async checkAuth(providerId: string, options?: AuthOperationOptions): Promise<AuthCheck | undefined> {
		return this.models.checkAuth(providerId, options);
	}

	async getAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly Model<Api>[]> {
		if (providerId) {
			const errorSeq = ++this.availabilityErrorSeq;
			try {
				const available = await this.models.getAvailable(providerId, options);
				if (errorSeq === this.availabilityErrorSeq) this.availabilityError = undefined;
				return available;
			} catch (error) {
				if (errorSeq === this.availabilityErrorSeq && !options?.signal?.aborted) {
					this.availabilityError = error instanceof Error ? error.message : String(error);
				}
				throw error;
			}
		}
		await this.queueAvailabilityRefresh(options?.signal);
		return this.snapshot.available;
	}

	getAvailableSnapshot(): readonly Model<Api>[] {
		return this.snapshot.available;
	}

	getError(): string | undefined {
		const errors: string[] = [];
		const configError = this.config.getError();
		if (configError) errors.push(configError);
		for (const [providerId, error] of this.compositionErrors) {
			errors.push(`Provider "${providerId}": ${error}`);
		}
		if (this.availabilityError) errors.push(`Availability refresh: ${this.availabilityError}`);
		return errors.length > 0 ? errors.join("\n\n") : undefined;
	}

	getRegisteredProviderConfig(providerId: string): ProviderConfigInput | undefined {
		return this.extensionProviders.get(providerId);
	}

	getRegisteredProviderIds(): readonly string[] {
		return [...new Set([...this.extensionProviders.keys(), ...this.nativeExtensionProviders.keys()])];
	}

	getRegisteredNativeProvider(providerId: string): Provider | undefined {
		return this.nativeExtensionProviders.get(providerId);
	}

	/** @internal Compatibility fallback for ModelRegistry when provider auth is unconfigured. */
	getCompatibilityRequestConfig(model: Model<Api>): CompatibilityRequestConfig {
		return resolveCompatibilityRequestConfig(
			model,
			this.config.getProvider(model.provider),
			this.extensionProviders.get(model.provider),
		);
	}

	isUsingOAuth(providerId: string): boolean {
		return this.snapshot.auth.get(providerId)?.type === "oauth";
	}

	isUsingSubscription(providerId: string): boolean {
		return this.isUsingOAuth(providerId) && this.models.getProvider(providerId)?.auth.oauth?.isSubscription === true;
	}

	hasConfiguredAuth(providerId: string): boolean {
		return this.snapshot.configuredProviders.has(providerId);
	}

	getAuth(providerId: string, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
	getAuth(model: Model<Api>, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
	async getAuth(
		providerOrModel: string | Model<Api>,
		overrides: ModelRuntimeAuthOverrides = {},
	): Promise<AuthResult | undefined> {
		if (typeof providerOrModel === "string") return this.models.getAuth(providerOrModel, overrides);
		const resolution = await this.models.getAuth(providerOrModel, overrides);
		if (!resolution) return undefined;
		const configuredHeaders = resolveConfiguredModelHeaders(
			providerOrModel,
			this.config.getProvider(providerOrModel.provider),
			this.extensionProviders.get(providerOrModel.provider),
			{ ...(resolution.env ?? {}), ...(overrides.env ?? {}) },
		);
		return {
			...resolution,
			auth: {
				...resolution.auth,
				headers: mergeHeaders(resolution.auth.headers, configuredHeaders),
			},
		};
	}

	private enqueueCredentialOperation<T>(providerId: string, signal: AbortSignal, task: () => Promise<T>): Promise<T> {
		const previous = this.credentialOperations.get(providerId) ?? Promise.resolve();
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const operation = (async () => {
			await previous.catch(() => {});
			signal.throwIfAborted();
			markStarted?.();
			return task();
		})();
		const tail = operation.catch(() => {});
		this.credentialOperations.set(providerId, tail);
		void tail.then(() => {
			if (this.credentialOperations.get(providerId) === tail) this.credentialOperations.delete(providerId);
		});
		return raceWithAbortSignal(started, signal).then(() => operation);
	}

	private async synchronizeCredentialState(
		providerId: string,
		operation: CredentialSynchronizationOperation,
		credential: Credential | undefined,
		signal: AbortSignal,
	): Promise<void> {
		try {
			signal.throwIfAborted();
			this.recomposeProvider(providerId);
			const compositionError = this.compositionErrors.get(providerId);
			if (compositionError) throw new Error(compositionError);
			const result = await this.models.refresh({ allowNetwork: false, providers: [providerId], signal });
			if (result.aborted) signal.throwIfAborted();
			const refreshError = result.errors.get(providerId);
			if (refreshError) throw refreshError;
			this.updateModelSnapshot();
			await this.refreshProviderAvailability(providerId, signal);
		} catch (cause) {
			throw new CredentialSynchronizationError(providerId, operation, credential, { cause });
		}
	}

	setRuntimeApiKey(providerId: string, apiKey: string, options: AuthOperationOptions = {}): Promise<void> {
		const signal = operationSignal(options.signal);
		return this.enqueueCredentialOperation(providerId, signal, async () => {
			this.credentials.setRuntimeApiKey(providerId, apiKey);
			await this.synchronizeCredentialState(
				providerId,
				"setRuntimeApiKey",
				{ type: "api_key", key: apiKey },
				signal,
			);
		});
	}

	removeRuntimeApiKey(providerId: string, options: AuthOperationOptions = {}): Promise<void> {
		const signal = operationSignal(options.signal);
		return this.enqueueCredentialOperation(providerId, signal, async () => {
			this.credentials.removeRuntimeApiKey(providerId);
			await this.synchronizeCredentialState(providerId, "removeRuntimeApiKey", undefined, signal);
		});
	}

	listCredentials(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		return this.credentials.list(options);
	}

	getProviderAuthStatus(providerId: string): AuthStatus {
		if (this.credentials.hasRuntimeApiKey(providerId)) return { configured: true, source: "runtime" };
		if (this.snapshot.storedProviders.has(providerId)) return { configured: true, source: "stored" };
		const configured = configuredRequestAuthStatus(
			this.config.getProvider(providerId),
			this.extensionProviders.get(providerId),
		);
		if (configured) return configured;
		const check = this.snapshot.auth.get(providerId);
		return check ? { configured: true, source: "environment", label: check.source } : { configured: false };
	}

	private async prepareRequest<TOptions extends ProviderRequestOptions & ModelsRequestTransforms>(
		model: Model<Api>,
		options: TOptions | undefined,
	): Promise<{
		provider: Provider;
		model: Model<Api>;
		options: Omit<TOptions, "transformHeaders"> & ProviderRequestOptions;
	}> {
		const provider = this.models.getProvider(model.provider);
		if (!provider) throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
		const resolution = await this.getAuth(model, {
			apiKey: options?.apiKey,
			env: options?.env,
			signal: options?.signal,
		});
		if (!resolution) throw new ModelsError("auth", `Provider is not configured: ${model.provider}`);

		const { transformHeaders, ...rawProviderOptions } = options ?? {};
		const providerOptions = rawProviderOptions as Omit<TOptions, "transformHeaders"> & ProviderRequestOptions;
		let headers = mergeHeaders(resolution.auth.headers, providerOptions.headers);
		if (transformHeaders) headers = await transformHeaders(headers ?? {});
		const env =
			resolution.env || providerOptions.env
				? { ...(resolution.env ?? {}), ...(providerOptions.env ?? {}) }
				: undefined;
		return {
			provider,
			model: resolution.auth.baseUrl ? { ...model, baseUrl: resolution.auth.baseUrl } : model,
			options: {
				...providerOptions,
				apiKey: providerOptions.apiKey ?? resolution.auth.apiKey,
				headers,
				env,
			} as Omit<TOptions, "transformHeaders"> & ProviderRequestOptions,
		};
	}

	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): AssistantMessageEventStream {
		return lazyStream(model, async () => {
			const prepared = await this.prepareRequest(
				model,
				options as (StreamOptions & ModelsRequestTransforms) | undefined,
			);
			return prepared.provider.stream(
				prepared.model as Model<TApi>,
				context,
				prepared.options as ApiStreamOptions<TApi>,
			);
		});
	}

	complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage> {
		return this.stream(model, context, options).result();
	}

	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {
		return lazyStream(model, () => this.attemptModel(model, context, options, undefined));
	}

	/** One model attempt: pool-based credential failover when configured, single-credential resolution otherwise. */
	private async attemptModel(
		model: Model<Api>,
		context: Context,
		options: ModelsSimpleStreamOptions | undefined,
		role: string | undefined,
	): Promise<ResultStream> {
		const pool = this.credentialPool;
		if (pool?.snapshot().some((entry) => entry.providerId === model.provider)) {
			return this.streamSimpleWithCredentialFailover(pool, model, context, options, role);
		}
		const prepared = await this.prepareRequest(model, options);
		const attemptStream = prepared.provider.streamSimple(
			prepared.model,
			context,
			prepared.options as SimpleStreamOptions,
		) as ResultStream;
		return this.instrumentAttempt(attemptStream, model, role, undefined);
	}

	/**
	 * Wraps a provider attempt stream with usage/latency recording, pass-through
	 * (no buffering, so live streaming is unaffected). Recording is triggered by
	 * the terminal (done/error) event itself, synchronously before that event is
	 * yielded onward. This matters: a consumer's `.result()` promise can resolve
	 * the instant the terminal event reaches it — one iteration step before a
	 * plain post-loop "the generator finished" check would fire — so recording
	 * after the loop exits would race a caller awaiting `.result()` and lose.
	 * Relies on every call site fully iterating the returned stream (all current
	 * ones do, via drainAttempt or lazyStream's forwardStream).
	 */
	/**
	 * Durable usage/cost/latency samples this runtime has recorded, if a store was
	 * configured. Read-only; callers query it (e.g. `aggregateUsagePerformance`)
	 * rather than this class exposing grouped views itself.
	 */
	async listUsagePerformanceSamples(): Promise<readonly UsagePerformanceSample[]> {
		return this.usagePerformanceStore ? await this.usagePerformanceStore.list() : [];
	}

	close(): void {
		this.usagePerformanceStore?.close?.();
	}

	private instrumentAttempt(
		stream: ResultStream,
		model: Model<Api>,
		role: string | undefined,
		credentialIdentity: CredentialIdentity | undefined,
	): ResultStream {
		const store = this.usagePerformanceStore;
		const otlpConfig = this.otlpExportConfig;
		if (!store && !otlpConfig) return stream;
		const now = this.performanceClock;
		const startedAt = now();
		const self = this;
		return {
			async *[Symbol.asyncIterator]() {
				let firstEventAt: number | undefined;
				for await (const event of stream) {
					if (firstEventAt === undefined) firstEventAt = now();
					if (event.type === "done" || event.type === "error") {
						const completedAt = now();
						const message = event.type === "done" ? event.message : event.error;
						const sample = self.buildUsageSample(model, role, credentialIdentity, message, {
							startedAt,
							firstEventAt: firstEventAt ?? completedAt,
							completedAt,
						});
						if (store) void store.record(sample).catch(() => {});
						if (otlpConfig) void exportUsageSampleSpan(sample, otlpConfig);
					}
					yield event;
				}
			},
			result: () => stream.result(),
		};
	}

	private buildUsageSample(
		model: Model<Api>,
		role: string | undefined,
		credentialIdentity: CredentialIdentity | undefined,
		message: AssistantMessage,
		timing: { startedAt: number; firstEventAt: number; completedAt: number },
	): UsagePerformanceSample {
		const outcome: UsagePerformanceSample["outcome"] =
			message.stopReason === "aborted" ? "aborted" : message.stopReason === "error" ? "error" : "success";
		const failureKind: CredentialFailureKind | undefined =
			outcome === "error" ? classifyCredentialFailure(message) : undefined;
		return {
			timestamp: Date.now(),
			provider: model.provider,
			model: model.id,
			role,
			credentialIdentity,
			outcome,
			failureKind,
			ttftMs: timing.firstEventAt - timing.startedAt,
			generationMs: timing.completedAt - timing.firstEventAt,
			usage: message.usage
				? {
						input: message.usage.input,
						output: message.usage.output,
						cacheRead: message.usage.cacheRead,
						cacheWrite: message.usage.cacheWrite,
					}
				: undefined,
			cost: message.usage?.cost.total,
		};
	}

	/**
	 * Opt-in role-based resolution: attempt each of a role's ordered model
	 * candidates in turn, exhausting that candidate's credential pool (Task 1.3)
	 * before advancing. A model visits at most once; since each visited model
	 * gets its own fresh credential-attempt set, no (credential, model) pair
	 * repeats across the whole call. A non-retryable failure on any candidate is
	 * terminal for the whole call — model fallback never masks a non-retryable
	 * error. Explicit CLI/session model selection is unaffected: callers must
	 * opt into this method instead of streamSimple().
	 */
	streamSimpleForRole(
		roleName: string,
		context: Context,
		options?: ModelsSimpleStreamOptions,
	): AssistantMessageEventStream {
		const outer = createAssistantMessageEventStream();
		this.attemptRole(roleName, context, options)
			.then((drained) => {
				for (const event of drained.events) outer.push(event);
				outer.end(drained.message);
			})
			.catch((error) => {
				const message: AssistantMessage = {
					role: "assistant",
					content: [],
					api: "role",
					provider: "role",
					model: roleName,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "error",
					errorMessage: error instanceof Error ? error.message : String(error),
					timestamp: Date.now(),
				};
				outer.push({ type: "error", reason: "error", error: message });
				outer.end(message);
			});
		return outer;
	}

	private async attemptRole(
		roleName: string,
		context: Context,
		options: ModelsSimpleStreamOptions | undefined,
	): Promise<{ events: readonly AssistantMessageEvent[]; message: AssistantMessage }> {
		const { roles } = this.resolveModelRoles();
		const candidates = roles.get(roleName);
		if (!candidates || candidates.length === 0) {
			throw new ModelsError("model_source", `Unknown or unresolved role: ${roleName}`);
		}

		let originalFailure: DrainedAttempt | undefined;
		for (const candidate of candidates) {
			options?.signal?.throwIfAborted();
			const attemptStream = await this.attemptModel(candidate, context, options, roleName);
			const drained = await drainAttempt(attemptStream);
			if (drained.message.stopReason !== "error") return drained;
			if (!originalFailure) originalFailure = drained;
			// Non-retryable (or aborted) is terminal for the whole role: model fallback
			// never masks an error rotation itself already declined to retry.
			if (!classifyCredentialFailure(drained.message)) return drained;
		}
		// originalFailure is always set here: candidates is non-empty, so the loop
		// ran at least once, and every path that returns early also sets it first.
		return originalFailure as DrainedAttempt;
	}

	/**
	 * Bounded, pre-completion credential failover: each attempt is fully drained
	 * before any event reaches the caller, so a rotated-away attempt is invisible
	 * to it. A turn visits each (credential identity, this model) at most once.
	 * Only a classified rate-limit/blocked/transient failure advances the chain;
	 * on exhaustion the original (first) failure is rethrown, not the last one.
	 */
	private async streamSimpleWithCredentialFailover(
		pool: CredentialPool,
		model: Model<Api>,
		context: Context,
		options: ModelsSimpleStreamOptions | undefined,
		role: string | undefined,
	): Promise<ResultStream> {
		const attempted = new Set<CredentialIdentity>();
		let originalFailure: ResultStream | undefined;

		for (;;) {
			options?.signal?.throwIfAborted();
			const selection = pool.select({ providerId: model.provider, attempted });
			if (!selection) {
				if (originalFailure) return originalFailure;
				// Pool configured for this provider but nothing currently eligible
				// (e.g. every entry cooling down): fall back to default auth resolution
				// so the caller still gets a real attempt instead of a silent no-op.
				const prepared = await this.prepareRequest(model, options);
				const fallbackStream = prepared.provider.streamSimple(
					prepared.model,
					context,
					prepared.options as SimpleStreamOptions,
				) as ResultStream;
				return this.instrumentAttempt(fallbackStream, model, role, undefined);
			}
			attempted.add(selection.identity);

			const auth = this.resolveCredentialPoolAuth?.(selection.identity);
			const prepared = await this.prepareRequest(model, {
				...options,
				apiKey: auth?.apiKey ?? options?.apiKey,
				env: auth?.env ?? options?.env,
			});
			const attemptStream = this.instrumentAttempt(
				prepared.provider.streamSimple(
					prepared.model,
					context,
					prepared.options as SimpleStreamOptions,
				) as ResultStream,
				model,
				role,
				selection.identity,
			);
			const drained = await drainAttempt(attemptStream);

			const kind = classifyCredentialFailure(drained.message);
			if (!kind) return replayAttempt(drained);

			pool.recordFailure({ identity: selection.identity, kind });
			if (!originalFailure) originalFailure = replayAttempt(drained);
		}
	}

	completeSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): Promise<AssistantMessage> {
		return this.streamSimple(model, context, options).result();
	}

	async fetchDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredFetchOptions,
	): Promise<AssistantMessage> {
		return lazyStream(model, async () => {
			const prepared = await this.prepareRequest(model, options);
			if (!prepared.provider.fetchDeferred) {
				throw new ModelsError("provider", `Provider ${model.provider} does not support deferred responses`);
			}
			return prepared.provider.fetchDeferred(prepared.model, handle, prepared.options as DeferredFetchOptions);
		}).result();
	}

	async cancelDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredCancelOptions,
	): Promise<void> {
		const prepared = await this.prepareRequest(model, options);
		if (!prepared.provider.cancelDeferred) {
			throw new ModelsError("provider", `Provider ${model.provider} does not support deferred responses`);
		}
		await prepared.provider.cancelDeferred(prepared.model, handle, prepared.options as DeferredCancelOptions);
	}

	login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential> {
		const signal = operationSignal(interaction.signal);
		return this.enqueueCredentialOperation(providerId, signal, async () => {
			const credential = await this.models.login(providerId, type, { ...interaction, signal });
			await this.synchronizeCredentialState(providerId, "login", credential, signal);
			return credential;
		});
	}

	logout(providerId: string, options: AuthOperationOptions = {}): Promise<void> {
		const signal = operationSignal(options.signal);
		return this.enqueueCredentialOperation(providerId, signal, async () => {
			await this.models.logout(providerId, { signal });
			await this.synchronizeCredentialState(providerId, "logout", undefined, signal);
		});
	}

	async refresh(options: ModelsRefreshOptions = {}): Promise<ModelsRefreshResult> {
		this.config = await ModelConfig.load(this.modelsPath);
		this.configureRadiusProviders();
		if (options.providers) {
			for (const providerId of new Set(options.providers)) this.recomposeProvider(providerId);
			this.updateModelSnapshot();
		} else {
			this.rebuildProviders();
		}
		const refreshOptions = {
			...options,
			allowNetwork: options.allowNetwork ?? this.modelNetworkEnabled,
		};
		// Published pi-ai builds before ModelsStore returned void and accepted a provider ID.
		// The fallback keeps source-mode CLI tests working without rebuilding workspace dependencies.
		const result = ((await this.models.refresh(refreshOptions)) as ModelsRefreshResult | undefined) ?? {
			aborted: refreshOptions.signal?.aborted ?? false,
			errors: new Map(),
		};
		const errors = new Map(result.errors);
		this.updateModelSnapshot();
		if (options.providers) {
			await Promise.all(
				[...new Set(options.providers)].map(async (providerId) => {
					try {
						await this.refreshProviderAvailability(providerId, operationSignal(options.signal));
					} catch (error) {
						if (!options.signal?.aborted) {
							errors.set(providerId, error instanceof Error ? error : new Error(String(error)));
						}
					}
				}),
			);
		} else {
			try {
				await this.queueAvailabilityRefresh(options.signal);
			} catch {
				// Availability errors are recorded by the latest pass; refreshed models remain usable.
			}
		}
		return { aborted: result.aborted || (options.signal?.aborted ?? false), errors };
	}

	registerNativeProvider(provider: Provider): void {
		if (!provider.id.trim()) throw new Error("Provider id must not be empty.");
		this.extensionProviders.delete(provider.id);
		this.nativeExtensionProviders.set(provider.id, provider);
		this.recomposeProvider(provider.id);
		this.updateModelSnapshot();
		void this.refresh({ allowNetwork: false });
	}

	registerProvider(providerId: string, config: ProviderConfigInput): void {
		// Validate the incoming registration on its own, like the legacy registry:
		// a broken re-registration must throw without touching the stored config.
		validateExtensionProvider(providerId, this.builtins.get(providerId), this.config.getProvider(providerId), config);
		this.nativeExtensionProviders.delete(providerId);
		// Re-registration merges defined values over the previous registration and
		// preserves undefined ones, matching the legacy ModelRegistry contract.
		const previous = this.extensionProviders.get(providerId);
		const effective: ProviderConfigInput = { ...previous };
		for (const [key, value] of Object.entries(config)) {
			if (value !== undefined) (effective as Record<string, unknown>)[key] = value;
		}
		this.extensionProviders.set(providerId, effective);
		this.recomposeProvider(providerId);
		this.updateModelSnapshot();
		if (
			this.snapshot.storedProviders.has(providerId) ||
			configuredRequestAuthStatus(this.config.getProvider(providerId), effective)?.configured
		) {
			const configuredProviders = new Set(this.snapshot.configuredProviders).add(providerId);
			const auth = new Map(this.snapshot.auth);
			// Provisional entry until the async refresh lands; never clobber a real check result.
			if (!auth.get(providerId)) {
				auth.set(providerId, {
					type: effective.oauth && !effective.apiKey ? "oauth" : "api_key",
					source: "configured provider",
				});
			}
			this.snapshot = {
				...this.snapshot,
				auth,
				configuredProviders,
				available: this.snapshot.all.filter((model) => configuredProviders.has(model.provider)),
			};
		}
		void this.refresh({ allowNetwork: false });
	}

	unregisterProvider(providerId: string): void {
		this.extensionProviders.delete(providerId);
		this.nativeExtensionProviders.delete(providerId);
		this.recomposeProvider(providerId);
		this.updateModelSnapshot();
		void this.refresh({ allowNetwork: false });
	}
}
