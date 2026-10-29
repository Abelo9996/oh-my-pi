/**
 * Contract (review 3983906393): a store failure latched while RPC mode shuts
 * down must still reach the client. The notice is queued on the asynchronous
 * `stdoutQueue`, so the process has to drain that queue before it exits on
 * either path; otherwise the frames go with the process and the client either
 * sees a clean exit for a run whose transcript never became durable, or never
 * learns about a failure the mode already reported and then recovered from.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";

const tempDirs: TempDir[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

/**
 * The harness needs preconditions it cannot synthesize: POSIX `chmod` (0o500
 * denies writes only to a non-root user), FIFOs, and the `mkfifo` and `cat`
 * tools. Where any is missing the test skips rather than erroring.
 */
const unsupportedHarness =
	process.platform === "win32" ||
	Bun.which("mkfifo") === null ||
	Bun.which("cat") === null ||
	(typeof process.getuid === "function" && process.getuid() === 0);

/**
 * A FIFO, not a pipe, for stdout: Bun buffers a pipe's megabytes in userspace,
 * so the child never blocks on stdout and an undrained queue is invisible. The
 * FIFO's 64 KiB kernel buffer is the backpressure these contracts are about.
 */
function spawnRpcChild(options: { root: string; sessionDir: string }) {
	const fifoPath = path.join(options.root, "stdout.fifo");
	const mkfifo = Bun.spawnSync(["mkfifo", fifoPath]);
	expect(mkfifo.exitCode, mkfifo.stderr.toString()).toBe(0);
	// O_RDWR opens without waiting for a reader and keeps the buffered frames
	// alive until the parent drains, even if the child exits first. O_NONBLOCK
	// gives the child the non-blocking stdout a pipe would.
	const fifo = fs.openSync(fifoPath, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
	let fifoOpen = true;
	const releaseFifo = (): void => {
		if (!fifoOpen) return;
		fifoOpen = false;
		fs.closeSync(fifo);
	};

	const agentDir = path.join(options.root, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	const packageRoot = path.join(import.meta.dir, "..", "..");
	const child = Bun.spawn(
		[
			"bun",
			path.join(packageRoot, "src", "cli.ts"),
			"--mode",
			"rpc",
			"--session-dir",
			options.sessionDir,
			"--no-extensions",
			"--no-skills",
			"--no-rules",
		],
		{
			cwd: packageRoot,
			env: {
				...Bun.env,
				ANTHROPIC_API_KEY: "sk-ant-not-a-real-key",
				PI_NO_TITLE: "1",
				NO_COLOR: "1",
				XDG_DATA_HOME: options.root,
				XDG_CONFIG_HOME: options.root,
				PI_CODING_AGENT_DIR: agentDir,
			},
			stdin: "pipe",
			stdout: fifo,
			stderr: "pipe",
		},
	);

	// The stderr mirror is written the moment the store latches, so it doubles as
	// the signal that the failure is in place before the directory is reopened.
	const decoder = new TextDecoder();
	let stderrText = "";
	const stderrListeners = new Set<() => void>();
	void (async () => {
		for await (const chunk of child.stderr as ReadableStream<Uint8Array>) {
			stderrText += decoder.decode(chunk);
			for (const listener of stderrListeners) listener();
		}
	})();

	return {
		child,
		release: () => {
			releaseFifo();
			child.kill();
		},
		stderrText: () => stderrText,
		/** Resolves on the stderr chunk carrying `needle`; the budget only bounds a hung child. */
		waitForStderr: (needle: string, budgetMs: number): Promise<boolean> => {
			const { promise, resolve } = Promise.withResolvers<boolean>();
			const settle = (found: boolean): void => {
				clearTimeout(timer);
				stderrListeners.delete(check);
				resolve(found);
			};
			const check = (): void => {
				if (stderrText.includes(needle)) settle(true);
			};
			const timer = setTimeout(() => settle(false), budgetMs);
			stderrListeners.add(check);
			check();
			return promise;
		},
		/**
		 * Read every frame the child writes until it exits. `cat` blocks in the
		 * kernel until data arrives, so the parent awaits real I/O instead of
		 * polling for EAGAIN. Its read end is opened here, before the parent's end
		 * is released, so frames buffered by a child that already exited survive.
		 * Once the child is gone and the parent's end is released, no writer is
		 * left and `cat` reaches EOF after the last buffered byte. The budget only
		 * bounds a child that never exits.
		 */
		drain: async (budgetMs: number): Promise<string> => {
			// Blocking O_RDONLY: the parent's open O_RDWR end lets it return at once.
			const readEnd = fs.openSync(fifoPath, fs.constants.O_RDONLY);
			const reader = Bun.spawn(["cat"], { stdin: readEnd, stdout: "pipe", stderr: "ignore" });
			fs.closeSync(readEnd);
			const output = new Response(reader.stdout).text();
			const timer = setTimeout(() => child.kill(), budgetMs);
			try {
				await child.exited;
			} finally {
				clearTimeout(timer);
				releaseFifo();
			}
			return output;
		},
	};
}

/** A stdout backlog the parent deliberately refuses to read yet. */
function backlogFrames(): string {
	const frames: string[] = [];
	for (let index = 0; index < 400; index++) {
		frames.push(JSON.stringify({ id: `page-${index}`, type: "get_available_commands" }));
	}
	frames.push(JSON.stringify({ id: "boom", type: "new_session" }));
	return `${frames.join("\n")}\n`;
}

function findPersistenceNotice(output: string): Record<string, unknown> | undefined {
	for (const line of output.split("\n")) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (isRecord(parsed) && parsed.type === "notice" && parsed.source === "session-persistence") return parsed;
	}
	return undefined;
}

/**
 * Deliberate stall, not a duration guess: the condition under test is whether
 * the child keeps the process alive for its queued frames, and a process that
 * decides not to has no event to await.
 */
const exitedWhileQueued = (child: { exited: Promise<number> }): Promise<boolean> =>
	Promise.race([child.exited.then(() => true), Bun.sleep(2_000).then(() => false)]);

describe.skipIf(unsupportedHarness)("RPC shutdown on a failed session store", () => {
	it("drains the queued notice before exiting on a persistence failure", async () => {
		const dir = TempDir.createSync("@pi-rpc-shutdown-");
		tempDirs.push(dir);
		const root = dir.path();
		// A session directory the process can read but not write: the first
		// persistence write fails with EACCES and the store latches the failure,
		// exactly as a full or unplugged disk would.
		const sessionDir = path.join(root, "sessions");
		fs.mkdirSync(sessionDir, { recursive: true });
		fs.chmodSync(sessionDir, 0o500);

		const { child, release, stderrText, drain } = spawnRpcChild({ root, sessionDir });
		try {
			child.stdin.write(backlogFrames());
			await child.stdin.flush();
			child.stdin.end();

			const wasQueuedAtDrain = await exitedWhileQueued(child);
			const output = await drain(20_000);
			const exitCode = await child.exited;

			expect(exitCode).toBe(1);
			const notice = findPersistenceNotice(output);
			expect(notice?.level).toBe("error");
			expect(String(notice?.message)).toContain("Session persistence failed: ");
			// The mode's own teardown claim is on stderr; the raw fatal dump the
			// review complains about never gets this far.
			expect(stderrText()).toContain("Session persistence is still failing at shutdown: ");
			// The mechanism: without the drain the child is gone before the parent
			// reads a single frame, so nothing above could pass.
			expect(wasQueuedAtDrain).toBe(false);
		} finally {
			release();
			fs.chmodSync(sessionDir, 0o700);
		}
	}, 30_000);

	it("drains a recovered failure's notice before exiting successfully", async () => {
		const dir = TempDir.createSync("@pi-rpc-recovered-");
		tempDirs.push(dir);
		const root = dir.path();
		const sessionDir = path.join(root, "sessions");
		fs.mkdirSync(sessionDir, { recursive: true });
		fs.chmodSync(sessionDir, 0o500);

		const { child, release, waitForStderr, drain } = spawnRpcChild({ root, sessionDir });
		try {
			child.stdin.write(backlogFrames());
			await child.stdin.flush();
			// The store rejects the first write, so a notice is queued behind the
			// backlog the parent is still not reading.
			expect(await waitForStderr("Session persistence failed: ", 20_000)).toBe(true);

			// The store recovers: a successful rewrite clears the latch, so dispose
			// resolves and the mode leaves through its success path. A second
			// `new_session` cannot be used here: it awaits `#drainAndCloseWriter`
			// before `#resetToNewSession` clears the error, so it replays the latch.
			fs.chmodSync(sessionDir, 0o700);
			child.stdin.write(`${JSON.stringify({ id: "recover", type: "set_session_name", name: "after-failure" })}\n`);
			await child.stdin.flush();
			child.stdin.end();

			const wasQueuedAtDrain = await exitedWhileQueued(child);
			const output = await drain(20_000);
			const exitCode = await child.exited;

			expect(exitCode).toBe(0);
			// The notice the mode already emitted on the failed write still reaches
			// the client, even though the run itself recovered and reported success.
			const notice = findPersistenceNotice(output);
			expect(notice?.level).toBe("error");
			expect(String(notice?.message)).toContain("Session persistence failed: ");
			// The mechanism: without the success-path drain the child is gone before
			// the parent reads a single frame, so the notice above is lost.
			expect(wasQueuedAtDrain).toBe(false);
		} finally {
			release();
			fs.chmodSync(sessionDir, 0o700);
		}
	}, 30_000);
});
