import { type SpawnSyncReturns, spawnSync } from "child_process";
import { createHash } from "crypto";
import {
	chmodSync,
	createReadStream,
	createWriteStream,
	existsSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
} from "fs";
import { arch, platform } from "os";
import { basename, join, relative, resolve as resolvePath } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { getBinDir } from "../config.ts";
import { getApexEnvironment } from "../core/environment.ts";
import { fetchWithRetry } from "./management-http.ts";

const TOOLS_DIR = getBinDir();
const DOWNLOAD_TIMEOUT_MS = 120_000;

function isOfflineModeEnabled(): boolean {
	const value = getApexEnvironment("APEX_CODE_OFFLINE");
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

interface ToolConfig {
	name: string;
	repo: string; // GitHub repo (e.g., "sharkdp/fd")
	binaryName: string; // Name of the binary inside the archive
	systemBinaryNames?: string[]; // Alternative system command names to try before downloading
	tagPrefix: string; // Prefix for tags (e.g., "v" for v1.0.0, "" for 1.0.0)
}

// Per-platform/architecture asset names live in MANAGED_TOOL_PINS (ADR 0017) as the
// single reviewed source of truth, not derived here.
const TOOLS: Record<string, ToolConfig> = {
	fd: {
		name: "fd",
		repo: "sharkdp/fd",
		binaryName: "fd",
		systemBinaryNames: ["fd", "fdfind"],
		tagPrefix: "v",
	},
	rg: {
		name: "ripgrep",
		repo: "BurntSushi/ripgrep",
		binaryName: "rg",
		tagPrefix: "",
	},
};

// Check if a command exists in PATH by trying to run it
function commandExists(cmd: string): boolean {
	try {
		const result = spawnSync(cmd, ["--version"], { stdio: "pipe" });
		// Check for ENOENT error (command not found)
		return result.error === undefined || result.error === null;
	} catch {
		return false;
	}
}

// Get the path to a tool (system-wide or in our tools dir)
export function getToolPath(tool: "fd" | "rg", options: { toolsDirectory?: string } = {}): string | null {
	const config = TOOLS[tool];
	if (!config) return null;

	// Check our tools directory first. Existence alone is not enough: the sandbox
	// projects host tools by bind-mounting over a file here, and bwrap leaves that
	// mountpoint behind as an empty, non-executable stub once the namespace is gone.
	const managedPath = join(
		options.toolsDirectory ?? TOOLS_DIR,
		config.binaryName + (platform() === "win32" ? ".exe" : ""),
	);
	if (isExecutableFile(managedPath, platform())) {
		return managedPath;
	}

	// Check system PATH - if found, just return the command name (it's in PATH)
	const systemBinaryNames = config.systemBinaryNames ?? [config.binaryName];
	for (const systemBinaryName of systemBinaryNames) {
		if (commandExists(systemBinaryName)) {
			return systemBinaryName;
		}
	}

	return null;
}

/**
 * Reviewed, pinned release metadata for auto-downloaded executable tools (ADR 0017).
 * Never resolved from a mutable "latest" API call. Updating a version, asset name, or
 * digest here is itself the reviewed change that authorizes installing a new release.
 *
 * Every digest and byte size below was established by downloading the artifact,
 * computing its SHA-256 locally, and cross-checking that value against the
 * upstream-published digest (ripgrep's own `.sha256` release sidecars; GitHub's own
 * per-asset `digest` field for both projects) — not invented, and not taken from a
 * single unverified source.
 */
interface ManagedToolPin {
	version: string;
	assetName: string;
	sha256: string;
	expectedBytes: number;
	archiveKind: "tar.gz" | "zip";
}

const MANAGED_TOOL_PINS: Record<"fd" | "rg", Partial<Record<string, ManagedToolPin>>> = {
	rg: {
		"linux:x64": {
			version: "14.1.1",
			assetName: "ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz",
			sha256: "4cf9f2741e6c465ffdb7c26f38056a59e2a2544b51f7cc128ef28337eeae4d8e",
			expectedBytes: 2566310,
			archiveKind: "tar.gz",
		},
		"linux:arm64": {
			version: "14.1.1",
			assetName: "ripgrep-14.1.1-aarch64-unknown-linux-gnu.tar.gz",
			sha256: "c827481c4ff4ea10c9dc7a4022c8de5db34a5737cb74484d62eb94a95841ab2f",
			expectedBytes: 2047405,
			archiveKind: "tar.gz",
		},
		"darwin:x64": {
			version: "14.1.1",
			assetName: "ripgrep-14.1.1-x86_64-apple-darwin.tar.gz",
			sha256: "fc87e78f7cb3fea12d69072e7ef3b21509754717b746368fd40d88963630e2b3",
			expectedBytes: 2082672,
			archiveKind: "tar.gz",
		},
		"darwin:arm64": {
			version: "14.1.1",
			assetName: "ripgrep-14.1.1-aarch64-apple-darwin.tar.gz",
			sha256: "24ad76777745fbff131c8fbc466742b011f925bfa4fffa2ded6def23b5b937be",
			expectedBytes: 1787248,
			archiveKind: "tar.gz",
		},
		"win32:x64": {
			version: "14.1.1",
			assetName: "ripgrep-14.1.1-x86_64-pc-windows-msvc.zip",
			sha256: "d0f534024c42afd6cb4d38907c25cd2b249b79bbe6cc1dbee8e3e37c2b6e25a1",
			expectedBytes: 2058893,
			archiveKind: "zip",
		},
		// No upstream win32/arm64 ripgrep release asset exists at 14.1.1; resolution
		// fails closed for that combination rather than constructing a URL that 404s.
	},
	fd: {
		"linux:x64": {
			version: "10.4.2",
			assetName: "fd-v10.4.2-x86_64-unknown-linux-gnu.tar.gz",
			sha256: "def59805cd14b5651b68990855f426ad087f3b96881296d963910431ba3143c8",
			expectedBytes: 1700779,
			archiveKind: "tar.gz",
		},
		"linux:arm64": {
			version: "10.4.2",
			assetName: "fd-v10.4.2-aarch64-unknown-linux-gnu.tar.gz",
			sha256: "6c51f7c5446b3338b1e401ff15dc194c590bb2fa64fd43ff3278300f073adec5",
			expectedBytes: 1559490,
			archiveKind: "tar.gz",
		},
		// Upstream stopped shipping an Intel macOS fd binary after 10.3.0 (see
		// 7afd80d78, "pin fd for macos x64"); preserved here rather than special-cased.
		"darwin:x64": {
			version: "10.3.0",
			assetName: "fd-v10.3.0-x86_64-apple-darwin.tar.gz",
			sha256: "50d30f13fe3d5914b14c4fff5abcbd4d0cdab4b855970a6956f4f006c17117a3",
			expectedBytes: 1430203,
			archiveKind: "tar.gz",
		},
		"darwin:arm64": {
			version: "10.4.2",
			assetName: "fd-v10.4.2-aarch64-apple-darwin.tar.gz",
			sha256: "623dc0afc81b92e4d4606b380d7bc91916ba7b97814263e554d50923a39e480a",
			expectedBytes: 1328933,
			archiveKind: "tar.gz",
		},
		"win32:x64": {
			version: "10.4.2",
			assetName: "fd-v10.4.2-x86_64-pc-windows-msvc.zip",
			sha256: "b2816e506390a89941c63c9187d58a3cc10e9a55f2ef0685f9ea0eccaf7c98c8",
			expectedBytes: 1525898,
			archiveKind: "zip",
		},
		"win32:arm64": {
			version: "10.4.2",
			assetName: "fd-v10.4.2-aarch64-pc-windows-msvc.zip",
			sha256: "4f9110c2d5b33a7f760bfa5510f4c113d828109f7277d421b1053a9943c0fc92",
			expectedBytes: 1370473,
			archiveKind: "zip",
		},
	},
};

export interface ManagedToolArtifact {
	version: string;
	url: string;
	sha256: string;
	expectedBytes: number;
	/** Bounded download ceiling (ADR 0017): four times the reviewed expected size. */
	maxBytes: number;
	binaryName: string;
	archiveKind: "tar.gz" | "zip";
}

/** Resolve reviewed, pinned metadata for a managed tool. Never queries "latest". */
export function resolveManagedToolArtifact(options: {
	tool: "fd" | "rg";
	platform: NodeJS.Platform | string;
	architecture: string;
}): ManagedToolArtifact {
	const config = TOOLS[options.tool];
	const pin = MANAGED_TOOL_PINS[options.tool]?.[`${options.platform}:${options.architecture}`];
	if (!config || !pin) {
		throw new Error(`No reviewed pinned artifact for ${options.tool} on ${options.platform}/${options.architecture}`);
	}
	return {
		version: pin.version,
		url: `https://github.com/${config.repo}/releases/download/${config.tagPrefix}${pin.version}/${pin.assetName}`,
		sha256: pin.sha256,
		expectedBytes: pin.expectedBytes,
		maxBytes: pin.expectedBytes * 4,
		binaryName: config.binaryName,
		archiveKind: pin.archiveKind,
	};
}

// Download a file from URL, aborting if the declared or received size exceeds the
// bounded ceiling (ADR 0017) rather than writing an unbounded stream to disk.
async function downloadFile(url: string, dest: string, maxBytes: number): Promise<void> {
	const response = await fetchWithRetry(url, undefined, { timeoutMs: DOWNLOAD_TIMEOUT_MS });

	if (!response.ok) {
		throw new Error(`Failed to download: ${response.status}`);
	}

	if (!response.body) {
		throw new Error("No response body");
	}

	const declaredLength = Number(response.headers.get("content-length") ?? Number.NaN);
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		throw new Error(`Refusing download: declared size ${declaredLength} exceeds bounded limit ${maxBytes}`);
	}

	let received = 0;
	const source = Readable.fromWeb(response.body as any);
	source.on("data", (chunk: Buffer) => {
		received += chunk.length;
		if (received > maxBytes) {
			source.destroy(new Error(`Refusing download: exceeded bounded limit ${maxBytes} bytes`));
		}
	});

	const fileStream = createWriteStream(dest);
	try {
		await pipeline(source, fileStream);
	} catch (error) {
		rmSync(dest, { force: true });
		throw error;
	}
}

function findBinaryRecursively(rootDir: string, binaryFileName: string): string | null {
	const stack: string[] = [rootDir];

	while (stack.length > 0) {
		const currentDir = stack.pop();
		if (!currentDir) continue;

		const entries = readdirSync(currentDir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(currentDir, entry.name);
			if (entry.isFile() && entry.name === binaryFileName) {
				return fullPath;
			}
			if (entry.isDirectory()) {
				stack.push(fullPath);
			}
		}
	}

	return null;
}

function formatSpawnFailure(result: SpawnSyncReturns<Buffer>): string {
	if (result.error?.message) {
		return result.error.message;
	}
	const stderr = result.stderr?.toString().trim();
	if (stderr) {
		return stderr;
	}
	const stdout = result.stdout?.toString().trim();
	if (stdout) {
		return stdout;
	}
	return `exit status ${result.status ?? "unknown"}`;
}

function runExtractionCommand(command: string, args: string[]): string | null {
	const result = spawnSync(command, args, { stdio: "pipe" });
	if (!result.error && result.status === 0) {
		return null;
	}
	return `${command}: ${formatSpawnFailure(result)}`;
}

function extractTarGzArchive(archivePath: string, extractDir: string, assetName: string): void {
	const failure = runExtractionCommand("tar", ["xzf", archivePath, "-C", extractDir]);
	if (failure) {
		throw new Error(`Failed to extract ${assetName}: ${failure}`);
	}
}

function getWindowsTarCommand(): string {
	const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
	if (systemRoot) {
		const systemTar = join(systemRoot, "System32", "tar.exe");
		if (existsSync(systemTar)) {
			return systemTar;
		}
	}
	return "tar.exe";
}

function extractZipArchive(archivePath: string, extractDir: string, assetName: string): void {
	const failures: string[] = [];

	if (platform() === "win32") {
		// Windows ships bsdtar as tar.exe, which supports zip files. Prefer the
		// System32 binary over Git Bash's GNU tar, which does not handle zip archives.
		const tarFailure = runExtractionCommand(getWindowsTarCommand(), ["xf", archivePath, "-C", extractDir]);
		if (!tarFailure) return;
		failures.push(tarFailure);

		const script =
			"& { param($archive, $destination) $ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force }";
		const powershellFailure = runExtractionCommand("powershell.exe", [
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			script,
			archivePath,
			extractDir,
		]);
		if (!powershellFailure) return;
		failures.push(powershellFailure);
	} else {
		const unzipFailure = runExtractionCommand("unzip", ["-q", archivePath, "-d", extractDir]);
		if (!unzipFailure) return;
		failures.push(unzipFailure);

		const tarFailure = runExtractionCommand("tar", ["xf", archivePath, "-C", extractDir]);
		if (!tarFailure) return;
		failures.push(tarFailure);
	}

	throw new Error(`Failed to extract ${assetName}: ${failures.join("; ")}`);
}

async function sha256File(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) {
		hash.update(chunk as Buffer);
	}
	return hash.digest("hex");
}

export interface InstallManagedToolArchiveOptions {
	archivePath: string;
	destination: string;
	binaryName: string;
	archiveKind: "tar.gz" | "zip";
	expectedSha256: string;
	maxBytes: number;
}

/**
 * Verify a downloaded tool archive against its pinned digest, extract it into a
 * per-install quarantine directory, confirm the located binary did not escape that
 * quarantine, and only then atomically promote it into the live tools directory
 * (ADR 0017). Rejects a digest mismatch or an out-of-bounds archive before anything
 * is written to `destination`.
 */
export async function installManagedToolArchive(options: InstallManagedToolArchiveOptions): Promise<string> {
	const { archivePath, destination, binaryName, archiveKind, expectedSha256, maxBytes } = options;

	const { size } = statSync(archivePath);
	if (size > maxBytes) {
		throw new Error(`Refusing install: archive size ${size} exceeds bounded limit ${maxBytes}`);
	}

	const actualSha256 = await sha256File(archivePath);
	if (actualSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
		throw new Error(`Refusing install: digest mismatch for ${basename(archivePath)}`);
	}

	mkdirSync(destination, { recursive: true });
	const quarantineDirectory = join(
		destination,
		`.quarantine_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
	);
	mkdirSync(quarantineDirectory, { recursive: true });

	try {
		const assetName = basename(archivePath);
		if (archiveKind === "tar.gz") {
			extractTarGzArchive(archivePath, quarantineDirectory, assetName);
		} else {
			extractZipArchive(archivePath, quarantineDirectory, assetName);
		}

		const binaryFileName = binaryName + (platform() === "win32" ? ".exe" : "");
		const extractedBinary = findBinaryRecursively(quarantineDirectory, binaryFileName);
		if (!extractedBinary) {
			throw new Error(`Binary not found in verified archive: expected ${binaryFileName}`);
		}

		const resolvedBinary = resolvePath(extractedBinary);
		const containmentPath = relative(resolvePath(quarantineDirectory), resolvedBinary);
		if (containmentPath.startsWith("..") || resolvePath(containmentPath) === containmentPath) {
			throw new Error(`Refusing install: archive entry escaped its quarantine directory: ${extractedBinary}`);
		}

		const finalPath = join(destination, binaryFileName);
		renameSync(resolvedBinary, finalPath);
		if (platform() !== "win32") {
			chmodSync(finalPath, 0o755);
		}
		return finalPath;
	} finally {
		rmSync(quarantineDirectory, { recursive: true, force: true });
	}
}

// Download and install a tool from reviewed, pinned metadata (ADR 0017): bounded
// download, digest verification, quarantine extraction, then atomic promotion.
async function downloadTool(tool: "fd" | "rg"): Promise<string> {
	const plat = platform();
	const architecture = arch();
	const artifact = resolveManagedToolArtifact({ tool, platform: plat, architecture });

	mkdirSync(TOOLS_DIR, { recursive: true });

	// Unique download filename: fd and rg downloads can run concurrently during
	// startup, so sharing a fixed path causes races.
	const archivePath = join(
		TOOLS_DIR,
		`download_${artifact.binaryName}_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}${
			artifact.archiveKind === "zip" ? ".zip" : ".tar.gz"
		}`,
	);

	try {
		await downloadFile(artifact.url, archivePath, artifact.maxBytes);
		return await installManagedToolArchive({
			archivePath,
			destination: TOOLS_DIR,
			binaryName: artifact.binaryName,
			archiveKind: artifact.archiveKind,
			expectedSha256: artifact.sha256,
			maxBytes: artifact.maxBytes,
		});
	} finally {
		rmSync(archivePath, { force: true });
	}
}

export interface HostToolBinary {
	/** File name the child looks for in its own tools directory ("fd", "rg", "fd.exe"). */
	name: string;
	/** Absolute host path to the executable backing that name. */
	path: string;
}

function isExecutableFile(candidate: string, targetPlatform: NodeJS.Platform): boolean {
	try {
		const stats = statSync(candidate);
		if (!stats.isFile()) return false;
		// Windows has no POSIX execute bit; presence of the file is the only signal.
		return targetPlatform === "win32" || (stats.mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

/**
 * Absolute host path for a managed tool, or undefined when it is installed nowhere.
 *
 * `getToolPath` may return a bare command name because its caller spawns through PATH.
 * A sandboxed child has no such luxury: its PATH still lists host directories that the
 * OS boundary has already replaced, so the supervisor must resolve a real path here and
 * project it in (ADR 0017, and the sandbox spec's tool-projection amendment).
 */
export function resolveHostToolBinary(
	tool: "fd" | "rg",
	options: { toolsDirectory?: string; pathValue?: string; platform?: NodeJS.Platform } = {},
): string | undefined {
	const config = TOOLS[tool];
	if (!config) return undefined;

	const targetPlatform = options.platform ?? platform();
	const executableSuffix = targetPlatform === "win32" ? ".exe" : "";
	const managedPath = join(options.toolsDirectory ?? TOOLS_DIR, config.binaryName + executableSuffix);
	if (isExecutableFile(managedPath, targetPlatform)) {
		return managedPath;
	}

	const pathEntries = (options.pathValue ?? process.env.PATH ?? "")
		.split(targetPlatform === "win32" ? ";" : ":")
		.filter((entry) => entry.length > 0);
	// Preference runs by name first, matching getToolPath: a real `fd` anywhere on PATH
	// beats a `fdfind` alias, rather than whichever directory happens to come first.
	for (const systemBinaryName of config.systemBinaryNames ?? [config.binaryName]) {
		for (const entry of pathEntries) {
			const candidate = join(entry, systemBinaryName + executableSuffix);
			if (isExecutableFile(candidate, targetPlatform)) {
				return candidate;
			}
		}
	}

	return undefined;
}

/**
 * Install any missing managed tool on the host, then report absolute paths for the ones
 * that exist. Downloading here rather than inside the child means one install serves every
 * workspace, and it happens on the side of the boundary that still has network access.
 */
export async function prepareHostToolBinaries(silent: boolean = false): Promise<HostToolBinary[]> {
	const binaries: HostToolBinary[] = [];
	for (const tool of ["fd", "rg"] as const) {
		await ensureTool(tool, silent ? undefined : ({ message }) => console.error(message));
		const hostPath = resolveHostToolBinary(tool);
		if (hostPath) {
			binaries.push({ name: TOOLS[tool].binaryName + (platform() === "win32" ? ".exe" : ""), path: hostPath });
		}
	}
	return binaries;
}

// Termux package names for tools
const TERMUX_PACKAGES: Record<string, string> = {
	fd: "fd",
	rg: "ripgrep",
};

export interface ToolStatus {
	type: "info" | "warning";
	message: string;
}

/**
 * Ensure a tool is available, downloading if necessary.
 * Reports progress through `onStatus`; status messages are otherwise silent.
 * Returns the tool path, or undefined if unavailable.
 */
export async function ensureTool(
	tool: "fd" | "rg",
	onStatus?: (status: ToolStatus) => void,
): Promise<string | undefined> {
	const existingPath = getToolPath(tool);
	if (existingPath) {
		return existingPath;
	}

	const config = TOOLS[tool];
	if (!config) return undefined;

	if (isOfflineModeEnabled()) {
		onStatus?.({ type: "warning", message: `${config.name} not found. Offline mode enabled, skipping download.` });
		return undefined;
	}

	// On Android/Termux, Linux binaries don't work due to Bionic libc incompatibility.
	// Users must install via pkg.
	if (platform() === "android") {
		const pkgName = TERMUX_PACKAGES[tool] ?? tool;
		onStatus?.({ type: "warning", message: `${config.name} not found. Install with: pkg install ${pkgName}` });
		return undefined;
	}

	// Tool not found - download it
	onStatus?.({ type: "info", message: `${config.name} not found. Downloading...` });

	try {
		const path = await downloadTool(tool);
		onStatus?.({ type: "info", message: `${config.name} installed to ${path}` });
		return path;
	} catch (e) {
		onStatus?.({
			type: "warning",
			message: `Failed to download ${config.name}: ${e instanceof Error ? e.message : e}`,
		});
		return undefined;
	}
}
