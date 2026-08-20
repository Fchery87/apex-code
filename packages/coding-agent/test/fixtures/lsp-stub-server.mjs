import { appendFileSync, writeFileSync } from "node:fs";

const logPath = process.env.APEX_LSP_STUB_LOG;
const initializeDelayMs = Number(process.env.APEX_LSP_STUB_INITIALIZE_DELAY_MS ?? "0");
const initializeRequestMethod = process.env.APEX_LSP_STUB_INITIALIZE_REQUEST_METHOD;
// Parameterized capabilities/diagnostics behavior, reused (not forked) across LSP.1's
// handshake tests and LSP.4's diagnostics-collector tests.
const textDocumentSyncMode = process.env.APEX_LSP_STUB_TEXT_DOCUMENT_SYNC;
const diagnosticsMode = process.env.APEX_LSP_STUB_DIAGNOSTICS;
// LSP.3: when set, report this server's own process.env before doing anything else,
// so a sandboxed-launch test can assert on what the spawned child actually saw
// (private sandbox state paths) rather than what the spawning process saw.
const reportEnvPath = process.env.APEX_LSP_STUB_REPORT_ENV_PATH;
if (reportEnvPath) writeFileSync(reportEnvPath, JSON.stringify(process.env));
let nextServerRequestId = 1000;
let input = Buffer.alloc(0);
let shutdownRequested = false;
const pending = new Map();

function log(message) {
	if (logPath) appendFileSync(logPath, `${JSON.stringify(message)}\n`);
}

function send(message) {
	const json = JSON.stringify(message);
	process.stdout.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`);
}

function respond(message, result) {
	send({ jsonrpc: "2.0", id: message.id, result });
}

function initializeCapabilities() {
	// Only "full" is needed by any current caller; other/absent values keep
	// today's bare `{}` so existing handshake tests do not regress.
	if (textDocumentSyncMode === "full") return { textDocumentSync: 1 };
	return {};
}

function publishDiagnosticsForVersion(uri, version) {
	if (!diagnosticsMode || diagnosticsMode === "none" || !uri || typeof version !== "number") return;
	if (diagnosticsMode === "stale-then-exact") {
		// A stale publish first, deliberately below the version the client is
		// waiting for, so the collector's version-attribution logic is exercised
		// rather than trivially satisfied by the first (and only) publish.
		send({
			jsonrpc: "2.0",
			method: "textDocument/publishDiagnostics",
			params: { uri, version: version - 1, diagnostics: [] },
		});
	}
	send({
		jsonrpc: "2.0",
		method: "textDocument/publishDiagnostics",
		params: {
			uri,
			version,
			diagnostics: [
				{
					message: `diagnostic for version ${version}`,
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
					severity: 1,
				},
			],
		},
	});
}

function handle(message) {
	log(message);
	if (message.method === "initialize" && "id" in message) {
		if (initializeRequestMethod) {
			const id = nextServerRequestId++;
			pending.set(id, { initializeMessage: message });
			send({ jsonrpc: "2.0", id, method: initializeRequestMethod, params: { items: [{ section: "x" }] } });
			return;
		}
		setTimeout(() => respond(message, { capabilities: initializeCapabilities() }), initializeDelayMs);
		return;
	}
	if ("id" in message && !message.method) {
		const serverRequest = pending.get(message.id);
		if (serverRequest?.initializeMessage) {
			pending.delete(message.id);
			setTimeout(() => respond(serverRequest.initializeMessage, { capabilities: initializeCapabilities() }), initializeDelayMs);
		}
		return;
	}
	if (message.method === "textDocument/didOpen" || message.method === "textDocument/didChange") {
		const textDocument = message.params?.textDocument;
		publishDiagnosticsForVersion(textDocument?.uri, textDocument?.version);
		return;
	}
	if (message.method === "test/exit") {
		process.exit(43);
	}
	if (message.method === "test/publish") {
		send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: message.params });
		return;
	}
	if (message.method === "test/echo" && "id" in message) {
		const delayMs = Number(message.params?.delayMs ?? 0);
		const timer = setTimeout(() => {
			pending.delete(message.id);
			respond(message, { value: message.params?.value });
		}, delayMs);
		pending.set(message.id, timer);
		return;
	}
	if (message.method === "$/cancelRequest") {
		const timer = pending.get(message.params?.id);
		if (timer) {
			clearTimeout(timer);
			pending.delete(message.params.id);
		}
		return;
	}
	if (message.method === "shutdown" && "id" in message) {
		shutdownRequested = true;
		respond(message, null);
		return;
	}
	if (message.method === "exit") {
		process.exit(shutdownRequested ? 0 : 1);
	}
}

function parse() {
	while (true) {
		const headerEnd = input.indexOf("\r\n\r\n");
		if (headerEnd < 0) return;
		const header = input.subarray(0, headerEnd).toString("ascii");
		const match = /(?:^|\r\n)Content-Length: (\d+)(?:\r\n|$)/i.exec(header);
		if (!match) process.exit(2);
		const length = Number(match[1]);
		const bodyStart = headerEnd + 4;
		if (input.length < bodyStart + length) return;
		const body = input.subarray(bodyStart, bodyStart + length).toString("utf8");
		input = input.subarray(bodyStart + length);
		handle(JSON.parse(body));
	}
}

process.stdin.on("data", (chunk) => {
	input = Buffer.concat([input, chunk]);
	parse();
});
