/**
 * MCP long-poll waits: a server may hold a call open for as long as the work
 * takes — a person answering, a queue draining — without sending a byte.
 *
 * The runtime arms a socket idle timer on exactly that silence (five minutes by
 * default), and it is invisible to the MCP timeout surface: a request an
 * operator had deliberately given no deadline (`timeout: 0`) still died with
 * `TimeoutError` while the server was still working, and the answer it later
 * sent was lost. `mcpFetch` disables that timer, which makes the transports'
 * AbortSignals the only thing that can end a wait — over Streamable HTTP and
 * over the legacy SSE transport, whose answer arrives on a different socket
 * than the POST — so the cancellation paths are pinned here alongside the wait.
 */
import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as mcpTimeout from "@oh-my-pi/pi-coding-agent/mcp/timeout";
import { HttpTransport } from "@oh-my-pi/pi-coding-agent/mcp/transports/http";
import { LegacySseTransport } from "@oh-my-pi/pi-coding-agent/mcp/transports/sse";
import { asGlobalFetch } from "./helpers/fetch-mock";

const DEADLINE_MS = 200;
/** The runtime's socket idle default: five minutes of silence ends a `fetch` that did not opt out. */
const RUNTIME_IDLE_MS = 5 * 60_000;
/** How long a long-poll server stays silent before it answers: past the idle default. */
const SILENCE_MS = RUNTIME_IDLE_MS + 60_000;

interface StallingServer {
	server: Bun.Server<undefined>;
	/** Resolves once the server has the request and is deliberately silent. */
	arrived: Promise<void>;
	/** Let the pending request finish so the process is not left holding it. */
	release: () => void;
}

let stalled: StallingServer[] = [];

afterEach(() => {
	for (const { server, release } of stalled) {
		release();
		server.stop(true);
	}
	stalled = [];
	vi.useRealTimers();
	vi.restoreAllMocks();
});

/** A server that accepts a JSON-RPC POST and then says nothing until released. */
function stallingServer(): StallingServer {
	const arrived = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	const server = Bun.serve({
		port: 0,
		// The client's idle timer is the subject; a server-side one would drop
		// the socket first and prove nothing.
		idleTimeout: 0,
		async fetch(request) {
			const body = (await request.json()) as { id: string | number };
			arrived.resolve();
			await gate.promise;
			return Response.json({ jsonrpc: "2.0", id: body.id, result: { waited: true } });
		},
	});
	const entry: StallingServer = { server, arrived: arrived.promise, release: gate.resolve };
	stalled.push(entry);
	return entry;
}

/**
 * A legacy (2024-11-05) server: it names its POST endpoint at once, then holds
 * every POST open. `arrived` resolves when a POST is in the server's hands.
 */
function legacySseServer(): StallingServer {
	const arrived = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	const encoder = new TextEncoder();
	const server = Bun.serve({
		port: 0,
		idleTimeout: 0,
		async fetch(request) {
			if (new URL(request.url).pathname === "/sse") {
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(encoder.encode("event: endpoint\ndata: /messages\n\n"));
						},
					}),
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			}
			await request.json();
			arrived.resolve();
			await gate.promise;
			return new Response(null, { status: 202 });
		},
	});
	const entry: StallingServer = { server, arrived: arrived.promise, release: gate.resolve };
	stalled.push(entry);
	return entry;
}

async function connected(server: Bun.Server<undefined>, timeout: number): Promise<HttpTransport> {
	const transport = new HttpTransport({ type: "http", url: `http://127.0.0.1:${server.port}/mcp`, timeout });
	await transport.connect();
	return transport;
}

/**
 * State the deadline a transport resolves instead of inheriting it from
 * `OMP_MCP_TIMEOUT_MS`. A spy on the module the transports read keeps the run
 * hermetic without mutating any global; `vi.restoreAllMocks()` undoes it.
 */
function pinDeadline(ms: number): void {
	spyOn(mcpTimeout, "resolveMCPTimeoutMs").mockReturnValue(ms);
}

/**
 * Stand in for the runtime's socket idle timer on the fake clock. The native
 * timer runs on a socket clock no test can drive (and current Bun no longer
 * lets a process shorten it), so `fetch` is wrapped with its contract: unless a
 * request passes `timeout: false`, a silence of `RUNTIME_IDLE_MS` — before the
 * response head or between body chunks — ends it with `TimeoutError`. Requests
 * still travel over real sockets to a real server.
 */
function emulateRuntimeIdleTimer(): void {
	const realFetch = globalThis.fetch;
	vi.spyOn(globalThis, "fetch").mockImplementation(
		asGlobalFetch(async (input, init) => {
			if ((init as { timeout?: unknown } | undefined)?.timeout === false) return realFetch(input, init);
			const idle = new AbortController();
			let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
			let source: ReadableStreamDefaultReader<Uint8Array> | undefined;
			let timer: NodeJS.Timeout | undefined;
			const disarm = (): void => clearTimeout(timer);
			const arm = (): void => {
				disarm();
				timer = setTimeout(() => {
					const error = new DOMException("The operation timed out.", "TimeoutError");
					idle.abort(error);
					bodyController?.error(error);
					source?.cancel(error).catch(() => undefined);
				}, RUNTIME_IDLE_MS);
			};
			arm();
			const signal = init?.signal ? AbortSignal.any([init.signal, idle.signal]) : idle.signal;
			let response: Response;
			try {
				response = await realFetch(input, { ...init, signal });
			} catch (error) {
				disarm();
				throw error;
			}
			if (!response.body) {
				disarm();
				return response;
			}
			arm();
			const reader = response.body.getReader();
			source = reader;
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					bodyController = controller;
				},
				async pull(controller) {
					const chunk = await reader.read();
					if (idle.signal.aborted) return;
					if (chunk.done) {
						disarm();
						controller.close();
						return;
					}
					arm();
					controller.enqueue(chunk.value);
				},
				cancel(reason) {
					disarm();
					return reader.cancel(reason);
				},
			});
			return new Response(body, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
		}),
	);
}

type Leg = { outcome: "resolved"; result: unknown } | { outcome: "threw"; name: string };

async function leg(run: () => Promise<unknown>): Promise<Leg> {
	try {
		return { outcome: "resolved", result: await run() };
	} catch (error) {
		return { outcome: "threw", name: error instanceof Error ? error.name : typeof error };
	}
}

/**
 * A long-poll server that takes each call and then sends nothing for
 * `SILENCE_MS` of fake time. Streamable HTTP calls are answered on their POST;
 * legacy calls are accepted with `202` at once and answered over the `/sse`
 * stream, whose last byte before the silence is the endpoint event.
 */
function longPollServer(expectedPosts: number) {
	const encoder = new TextEncoder();
	/** Armed on the fake clock, so only `vi.advanceTimersByTime` ends it. */
	const silence = (): Promise<void> => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, SILENCE_MS);
		return promise;
	};
	const postsArrived = Promise.withResolvers<void>();
	let posts = 0;
	const legacyPosted = Promise.withResolvers<string | number>();
	const server = Bun.serve({
		port: 0,
		// The client's idle timer is the subject; a server-side one would drop
		// the socket first and prove nothing.
		idleTimeout: 0,
		async fetch(request) {
			const { pathname } = new URL(request.url);
			if (pathname === "/sse") {
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(encoder.encode("event: endpoint\ndata: /messages\n\n"));
							void Promise.all([legacyPosted.promise, silence()]).then(([id]) => {
								const answer = { jsonrpc: "2.0", id, result: { waited: true } };
								try {
									controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(answer)}\n\n`));
									controller.close();
								} catch {
									// The client gave up and cancelled the stream; nothing to send it.
								}
							});
						},
					}),
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			}
			const body = (await request.json()) as { id: string | number };
			if (pathname === "/messages") {
				legacyPosted.resolve(body.id);
				return new Response(null, { status: 202 });
			}
			if (++posts === expectedPosts) postsArrived.resolve();
			await silence();
			return Response.json({ jsonrpc: "2.0", id: body.id, result: { waited: true } });
		},
	});
	return { server, postsArrived: postsArrived.promise, legacyPosted: legacyPosted.promise };
}

describe("MCP waits that outlast the socket idle timer", () => {
	it("delivers the answer on every MCP transport after a silence past the runtime's idle default", async () => {
		vi.useFakeTimers();
		emulateRuntimeIdleTimer();
		// The configuration an operator reaches for when waits are long: no
		// client-side MCP deadline at all.
		pinDeadline(0);
		// Three POSTs go silent before their head: the control, then both
		// `mcpFetch` paths — plain, and the manual-redirect one an origin-locked
		// server takes.
		const { server, postsArrived, legacyPosted } = longPollServer(3);
		const base = `http://127.0.0.1:${server.port}`;
		const url = `${base}/mcp`;
		const unlocked = new HttpTransport({ type: "http", url, timeout: 0 });
		const originLocked = new HttpTransport({ type: "http", url, timeout: 0, headerPolicy: "origin-locked" });
		const legacy = new LegacySseTransport({ type: "sse", url: `${base}/sse`, timeout: 0 });
		try {
			await Promise.all([unlocked.connect(), originLocked.connect(), legacy.connect()]);
			const streamSilent = Promise.withResolvers<void>();
			const legs = Promise.all([
				// Bare fetches without the MCP fetch policy prove the silence
				// crosses the idle boundary, before a response head and mid-stream.
				leg(async () => {
					const response = await fetch(url, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ jsonrpc: "2.0", id: "control", method: "tools/call", params: {} }),
					});
					return await response.json();
				}),
				leg(async () => {
					const reader = (await fetch(`${base}/sse`)).body!.getReader();
					await reader.read();
					streamSilent.resolve();
					while (!(await reader.read()).done) {}
					return "closed";
				}),
				leg(() => unlocked.request("tools/call")),
				leg(() => originLocked.request("tools/call")),
				leg(() => legacy.request("tools/call")),
			]);
			// Every wait has reached its silence before any time passes.
			await Promise.all([postsArrived, legacyPosted, streamSilent.promise]);
			vi.advanceTimersByTime(SILENCE_MS);
			const [control, controlStream, plain, locked, sse] = await legs;

			expect(control).toEqual({ outcome: "threw", name: "TimeoutError" });
			expect(controlStream).toEqual({ outcome: "threw", name: "TimeoutError" });
			expect(plain).toEqual({ outcome: "resolved", result: { waited: true } });
			expect(locked).toEqual({ outcome: "resolved", result: { waited: true } });
			// The legacy transport puts the silence on its GET stream while the
			// POST returns `202` at once, so a healthy-looking POST is no evidence
			// the answer will ever arrive. It must survive the same silence.
			expect(sse).toEqual({ outcome: "resolved", result: { waited: true } });
		} finally {
			await Promise.all([unlocked.close(), originLocked.close(), legacy.close()]);
			server.stop(true);
		}
	});

	it("lets caller cancellation end a wait that was given no deadline", async () => {
		pinDeadline(0);
		const { server, arrived } = stallingServer();
		const transport = await connected(server, 0);
		const caller = new AbortController();
		try {
			const settled = transport.request("tools/call", undefined, { signal: caller.signal }).then(
				() => undefined,
				(reason: unknown) => reason,
			);
			await arrived;
			caller.abort();

			const error = await settled;
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).name).toBe("AbortError");
		} finally {
			await transport.close();
		}
	});

	it("ends a wait that was given no deadline when the transport closes", async () => {
		pinDeadline(0);
		const { server, arrived } = stallingServer();
		const transport = await connected(server, 0);
		const settled = transport.request("tools/call").then(
			() => undefined,
			(reason: unknown) => reason,
		);
		await arrived;

		await transport.close();

		const error = await settled;
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).name).toBe("AbortError");
	});

	it("ends every legacy SSE POST that was given no deadline when the transport closes", async () => {
		// The legacy transport answers over the GET stream, so a POST it is still
		// holding is invisible to the pending-response map: `notify` has no entry
		// there at all. Without a lifecycle signal its promise never settles.
		pinDeadline(0);
		const { server, arrived } = legacySseServer();
		const transport = new LegacySseTransport({
			type: "sse",
			url: `http://127.0.0.1:${server.port}/sse`,
			timeout: 0,
		});
		await transport.connect();
		const notified = transport.notify("notifications/initialized").then(
			() => undefined,
			(reason: unknown) => reason,
		);
		const requested = transport.request("tools/call").then(
			() => undefined,
			(reason: unknown) => reason,
		);
		await arrived;

		await transport.close();

		const notifyError = await notified;
		expect(notifyError).toBeInstanceOf(Error);
		expect((notifyError as Error).name).toBe("AbortError");
		// And the waiter is told it was closed, not that a deadline it never had
		// expired.
		const requestError = await requested;
		expect(requestError).toBeInstanceOf(Error);
		expect((requestError as Error).name).toBe("AbortError");
	});

	it("still fails a silent wait at the configured MCP deadline", async () => {
		pinDeadline(DEADLINE_MS);
		const { server } = stallingServer();
		const transport = await connected(server, DEADLINE_MS);
		try {
			await expect(transport.request("tools/call")).rejects.toMatchObject({
				transport: "http",
				stage: "send",
				failure: "timeout",
				retryable: false,
			});
		} finally {
			await transport.close();
		}
	});
});
