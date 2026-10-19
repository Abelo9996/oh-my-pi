// Real broker, native IPC, and production wait/job consumers; only connection delivery is gated.
import { afterEach, describe, expect, test, vi } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { IpcConnection } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AsyncJobManager } from "../../src/async/job-manager";
import { Settings } from "../../src/config/settings";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import * as clients from "../../src/launch/client";
import { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../../src/launch/protocol";
import type { ToolSession } from "../../src/tools";
import { WaitTool } from "../../src/tools/wait";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { IrcBus } from "../../src/irc/bus";

async function withBroker(
	run: (client: clients.DaemonBrokerClient, session: ToolSession) => Promise<void>,
): Promise<void> {
	using root = TempDir.createSync("@omp-broker-discovery-");
	const projectDir = path.join(root.path(), "project");
	const runtimeDir = path.join(root.path(), "runtime");
	await fs.mkdir(projectDir);
	const client = await clients.createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
	const previousTitle = process.title;
	const env: Record<string, string> = {
		[DAEMON_PROJECT_DIR_ENV]: projectDir,
		[DAEMON_RUNTIME_DIR_ENV]: runtimeDir,
		[DAEMON_IDLE_GRACE_ENV]: "5000",
	};
	const previous: Record<string, string | undefined> = {};
	for (const key in env) {
		previous[key] = process.env[key];
		process.env[key] = env[key];
	}
	const listening = Promise.withResolvers<void>();
	const broker = startDaemonBrokerFromEnvironment({ onListening: listening.resolve });
	for (const key in previous) {
		const value = previous[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	const session: ToolSession = {
		cwd: projectDir,
		hasUI: false,
		settings: Settings.isolated({ "launch.enabled": true }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getAgentId: () => "owner",
		getSessionId: () => "owner",
		registerDisposeCallback: () => {},
		registerSessionChangeCallback: () => {},
	};
	try {
		await listening.promise;
		vi.spyOn(clients, "daemonClientForProject").mockResolvedValue(client);
		await run(client, session);
	} finally {
		vi.restoreAllMocks();
		await client.request({ op: "shutdown" }).catch(() => undefined);
		client.close();
		await broker;
		process.title = previousTitle;
	}
}

function holdConnection() {
	const connected = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const connect = IpcConnection.connect.bind(IpcConnection);
	vi.spyOn(IpcConnection, "connect").mockImplementationOnce(async (endpoint, options) => {
		const connection = await connect(endpoint, options);
		connected.resolve();
		await release.promise;
		return connection;
	});
	return { connected: connected.promise, release: release.resolve };
}

async function beforeRelease<T>(release: () => void, result: Promise<T>): Promise<T> {
	// Native socket delivery needs real platform timers; this watchdog only bounds a failed assertion.
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(() => {
		deadline.reject(new Error("Result did not precede connection release"));
		release();
	}, 2_000);
	try {
		return await Promise.race([result, deadline.promise]);
	} finally {
		clearTimeout(timer);
		release();
	}
}

afterEach(() => vi.restoreAllMocks());

describe("broker discovery during wait and request cancellation", () => {
	test("completed local job wakes wait before the broker connection is delivered", () =>
		withBroker(async (_client, session) => {
			const manager = new AsyncJobManager({ onJobComplete: () => {} });
			session.asyncJobManager = manager;
			const job = Promise.withResolvers<string>();
			const id = manager.register("bash", "build", async () => job.promise, { ownerId: "owner" });
			const gate = holdConnection();
			const waiting = new WaitTool(session).execute("wait-job", {});
			try {
				await gate.connected;
				job.resolve("built");
				const result = await beforeRelease(gate.release, waiting);
				expect(result.details?.jobs?.[0]).toMatchObject({ id, status: "completed", resultText: "built" });
			} finally {
				gate.release();
				await waiting.catch(() => undefined);
				await manager.dispose();
			}
		}));

	test("incoming message wakes wait while broker discovery is pending", () =>
		withBroker(async (_client, session) => {
			const registry = new AgentRegistry();
			registry.register({ id: "owner", displayName: "Owner", kind: "sub", session: null });
			session.agentRegistry = registry;
			const bus = new IrcBus(registry);
			vi.spyOn(IrcBus, "global").mockReturnValue(bus);
			const gate = holdConnection();
			const waiting = new WaitTool(session).execute("wait-message", {});
			try {
				await gate.connected;
				await bus.send({ from: "peer", to: "owner", body: "ready for review" }, { suppressRelay: true });
				const result = await beforeRelease(gate.release, waiting);
				expect(result.details?.waited).toMatchObject({ from: "peer", body: "ready for review" });
			} finally {
				gate.release();
				await waiting.catch(() => undefined);
				registry.unregister("owner");
			}
		}));

	test("wait limit covers broker discovery instead of starting after connection", () =>
		withBroker(async (_client, session) => {
			const manager = new AsyncJobManager({ onJobComplete: () => {} });
			session.asyncJobManager = manager;
			const job = Promise.withResolvers<string>();
			const id = manager.register("bash", "build", async () => job.promise, { ownerId: "owner" });
			const timers = vi.spyOn(globalThis, "setTimeout");
			const gate = holdConnection();
			const waiting = new WaitTool(session).execute("wait-limit", {});
			try {
				await gate.connected;
				const scheduled = timers.mock.calls.find(([, delay]) => delay === 30 * 60_000);
				if (!scheduled || typeof scheduled[0] !== "function") {
					throw new Error("Wait did not schedule its limit during discovery");
				}
				scheduled[0]();
				const result = await beforeRelease(gate.release, waiting);
				expect(result.details?.jobs?.[0]).toMatchObject({ id, status: "running" });
			} finally {
				gate.release();
				manager.cancel(id);
				job.resolve("done");
				await waiting.catch(() => undefined);
				await manager.dispose();
			}
		}));

	test("caller abort ends wait before the broker connection is delivered", () =>
		withBroker(async (_client, session) => {
			const manager = new AsyncJobManager({ onJobComplete: () => {} });
			session.asyncJobManager = manager;
			const job = Promise.withResolvers<string>();
			const id = manager.register("bash", "build", async () => job.promise, { ownerId: "owner" });
			const gate = holdConnection();
			const controller = new AbortController();
			const waiting = new WaitTool(session).execute("wait-abort", {}, controller.signal);
			const outcome = waiting.catch((error: unknown) => error);
			try {
				await gate.connected;
				controller.abort();
				const error = await beforeRelease(gate.release, outcome);
				expect(error).toMatchObject({ name: "ToolAbortError" });
			} finally {
				gate.release();
				manager.cancel(id);
				job.resolve("done");
				await outcome;
				await manager.dispose();
			}
		}));

	test("cancelled request sends nothing after connecting and leaves shared connection usable", () =>
		withBroker(async (client, session) => {
			const gate = holdConnection();
			const controller = new AbortController();
			const cancelled = client.request(
				{
					op: "start",
					spec: {
						name: "must-not-start",
						application: process.execPath,
						args: ["-e", "process.stdin.resume()"],
						env: {},
						cwd: session.cwd,
						pty: false,
						restart: "no",
						persist: false,
						detached: false,
					},
				},
				controller.signal,
			);
			const outcome = cancelled.catch((error: unknown) => error);
			const sibling = client.request({ op: "list" });
			try {
				await gate.connected;
				controller.abort();
				const error = await beforeRelease(gate.release, outcome);
				expect(error).toMatchObject({ message: "Daemon broker request aborted" });
				const listed = await sibling;
				if (listed.op !== "list") throw new Error("Expected real broker list");
				expect(listed.daemons.some(daemon => daemon.name === "must-not-start")).toBe(false);
			} finally {
				gate.release();
				await Promise.allSettled([cancelled, sibling]);
			}
		}));
	test("successful empty discovery reports no work", () =>
		withBroker(async (_client, session) => {
			await expect(new WaitTool(session).execute("wait-empty", {})).rejects.toThrow("Nothing to wait for");
		}));

	test("a failed discovery is not reported as no work", () =>
		withBroker(async (_client, session) => {
			const closed = await clients.createDaemonBrokerClient(session.cwd);
			closed.close();
			vi.spyOn(clients, "daemonClientForProject").mockResolvedValue(closed);
			await expect(new WaitTool(session).execute("wait-error", {})).rejects.toThrow(
				"Service state unavailable: Daemon broker client is closed",
			);
		}));
});
