import type { DevToolsConnection, DevToolsEvent } from "./browser-session.ts";

interface VersionInfo {
	webSocketDebuggerUrl: string;
}

/**
 * Connects to a Chrome DevTools port. Reads `/json/version` for the browser socket,
 * then speaks the command and event protocol over that socket.
 */
export async function connectDevTools(port: number): Promise<DevToolsConnection> {
	const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as VersionInfo;
	const socket = new WebSocket(version.webSocketDebuggerUrl);
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error(`browser could not connect to port ${port}`)), {
			once: true,
		});
	});

	let nextId = 1;
	const pending = new Map<number, (result: unknown) => void>();
	const queued: DevToolsEvent[] = [];
	socket.addEventListener("message", (message) => {
		const parsed = JSON.parse(String(message.data)) as { id?: number; result?: unknown } & DevToolsEvent;
		if (parsed.id !== undefined && pending.has(parsed.id)) {
			pending.get(parsed.id)?.(parsed.result);
			pending.delete(parsed.id);
			return;
		}
		if (parsed.method) queued.push(parsed);
	});

	return {
		request(method, params) {
			const id = nextId++;
			socket.send(JSON.stringify(params ? { id, method, params } : { id, method }));
			return new Promise((resolve) => {
				pending.set(id, (result) => {
					const events = queued.splice(0);
					resolve({ result, events });
				});
			});
		},
	};
}
