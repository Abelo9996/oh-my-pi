/**
 * `!command` config values must not leak inherited file descriptors into the
 * credential-resolving child, and a timed-out command must not leave
 * descendants running.
 *
 * A launcher can legitimately hand omp an open descriptor (for example a
 * credential bundle) that is meant to stay single-consumer. The child spawned
 * for `auth.broker.url` / header `!command` resolution used to run through the
 * natives brush shell (executeShell), whose children inherit every inheritable
 * descriptor; the models.yml apiKey resolver (execSync) already spawned with
 * stdio pipes only. The fix converges the config-value path on ptree, which
 * keeps piped-only stdio while preserving executeShell's process-tree
 * termination on timeout.
 *
 * Oracle notes: the fd oracle must be an external helper script whose body is
 * `cat <&3` — brush rejects inline `<&3` in the command string while still
 * passing inherited fds to external children. A positive control runs first so
 * the fd assertion cannot pass vacuously (e.g. if the resolver stopped
 * executing commands at all). The tree-kill oracle mirrors the contract pinned
 * by packages/natives/test/native.test.ts for executeShell. No /proc
 * dependency, so both oracles discriminate on every non-Windows platform.
 */
import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { runShellCommand } from "../src/config/resolve-config-value";
import { drive } from "./helpers/fake-clock";

const resolverUrl = pathToFileURL(path.join(import.meta.dir, "../src/config/resolve-config-value.ts")).href;

/**
 * Deadline handed to the resolver in the descendant-escape oracles below. The
 * clock is frozen, so it fires only when the oracle advances it — after the
 * worker has reported in. Racing a real deadline against starting `sh` and a
 * worker on a loaded runner flaked (#10259); a frozen one cannot lose that race.
 */
const RESOLVER_TIMEOUT_MS = 3000;

/** How long a killed descendant may take to actually exit; only a failing kill waits it out. */
const DEATH_GRACE_MS = 2000;

/** Escape workers report their pid through this named pipe; reading it is the readiness event. */
function makeReadyPipe(root: string): string {
	const readyPipe = path.join(root, "ready.fifo");
	const mkfifo = Bun.spawnSync(["mkfifo", readyPipe]);
	if (mkfifo.exitCode !== 0) throw new Error(`mkfifo failed: ${mkfifo.stderr.toString()}`);
	return readyPipe;
}

/**
 * Run `command` until its worker reports through `readyPipe`, fire the
 * resolver deadline, and assert the timeout kills that worker.
 *
 * Each worker `sleep 30`s and each command's shell outlives the frozen
 * deadline, so a descendant the product fails to kill is still running when
 * `DEATH_GRACE_MS` expires.
 */
async function expectTimeoutKillsWorker(command: string, readyPipe: string, label: string): Promise<void> {
	vi.useFakeTimers();
	const resolved = runShellCommand(command, RESOLVER_TIMEOUT_MS);
	// Opening the pipe blocks until the worker writes to it, so the worker is
	// running before the deadline fires.
	const pid = Number.parseInt((await fs.promises.readFile(readyPipe, "utf8")).trim(), 10);
	const worker = Process.fromPid(pid);
	try {
		expect(worker?.status(), `${label} worker ${pid} must be running before the timeout`).toBe(ProcessStatus.Running);
		vi.advanceTimersByTime(RESOLVER_TIMEOUT_MS);
		// The Linux subreaper sweep paces itself with timers; drive them while the kill completes.
		expect(await drive(resolved)).toBeUndefined();
		// The kill is the contract. Comparing its latency against a write the
		// descendant performs after a delay only measured how fast the runner
		// was, and failed a working tree-kill whenever it lost that race.
		const exited = await worker?.waitForExit({ timeoutMs: DEATH_GRACE_MS });
		expect(exited, `${label} descendant ${pid} survived the timeout`).toBe(true);
	} finally {
		worker?.killTree(9);
	}
}

/**
 * Worker script that waits until its launching shell (pid in `$1`) has exited
 * — gone or a zombie — then reports in, so it is a reparented orphan before
 * the deadline fires.
 */
function reparentedWorkerScript(readyPipe: string): string {
	return `#!/bin/sh\nwhile ps -o stat= -p "$1" | grep -qv Z; do sleep 0.01; done\necho $$ > "${readyPipe}"\nexec sleep 30\n`;
}

const roots: string[] = [];

afterEach(async () => {
	vi.useRealTimers();
	for (const root of roots.splice(0)) await fs.promises.rm(root, { recursive: true, force: true });
});

test.skipIf(process.platform === "win32")(
	"config !command children cannot read descriptors the launcher passed omp",
	async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-config-fd-"));
		roots.push(root);
		const canaryPath = path.join(root, "canary.txt");
		await fs.promises.writeFile(canaryPath, "CANARY-THAT-MUST-NOT-RESOLVE");
		const spyPath = path.join(root, "fd3-spy.sh");
		await fs.promises.writeFile(spyPath, "#!/usr/bin/env bash\ncat <&3\n", { mode: 0o755 });

		// The child receives fd 3 the way a launcher would pass one: an extra
		// stdio entry, dup2'd in regardless of close-on-exec state.
		const canary = await fs.promises.open(canaryPath, "r");
		try {
			// The resolver must load in a child process: fd inheritance only exists
			// across a real exec boundary, so the probe runs via --eval in a spawned
			// bun (same pattern as cli-provider-api-keys.test.ts). The positive
			// control asserts command execution works through the same resolver
			// before the fd case requires `undefined`.
			const script = `import { resolveConfigValue } from ${JSON.stringify(resolverUrl)};
const control = await resolveConfigValue("!echo positive-control-ok");
console.log(control === "positive-control-ok" ? "CONTROL-OK" : "CONTROL-BAD:" + control);
const value = await resolveConfigValue("!${spyPath}");
console.log(value === undefined ? "RESOLVED-UNDEFINED" : "LEAKED:" + value);
`;
			const proc = Bun.spawn({
				cmd: [process.execPath, "--eval", script],
				cwd: process.cwd(),
				stdio: ["ignore", "pipe", "pipe", canary.fd],
				timeout: 15_000,
			});
			const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
			expect(exitCode, stdout).toBe(0);
			const lines = stdout.trim().split("\n");
			expect(lines[0], "positive control: commands must still resolve").toBe("CONTROL-OK");
			expect(lines[1], "fd oracle: the canary must not resolve").toBe("RESOLVED-UNDEFINED");
		} finally {
			await canary.close();
		}
	},
);

test.skipIf(process.platform === "win32")("a timed-out !command kills the descendant it backgrounded", async () => {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-config-treekill-"));
	roots.push(root);
	const readyPipe = makeReadyPipe(root);
	const worker = path.join(root, "worker.sh");
	await fs.promises.writeFile(worker, `#!/bin/sh\necho $$ > "${readyPipe}"\nexec sleep 30\n`, { mode: 0o755 });

	await expectTimeoutKillsWorker(`"${worker}" & sleep 30`, readyPipe, "backgrounded");
});

test.skipIf(process.platform === "win32")(
	"a timed-out !command kills descendants reparented before the timeout",
	async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-config-reparented-"));
		roots.push(root);
		const readyPipe = makeReadyPipe(root);
		const worker = path.join(root, "escaped-worker.sh");
		await fs.promises.writeFile(worker, reparentedWorkerScript(readyPipe), { mode: 0o755 });

		// The intermediate shell exits immediately after backgrounding the
		// worker, and the worker reports only once reparented, so PID-tree
		// traversal can no longer find it when the timeout fires.
		await expectTimeoutKillsWorker(`sh -c '"${worker}" $$ &' & sleep 30`, readyPipe, "reparented");
	},
);

test.skipIf(process.platform !== "linux")(
	"a timed-out !command kills descendants that leave the isolated session",
	async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-config-session-escape-"));
		roots.push(root);
		const readyPipe = makeReadyPipe(root);
		const worker = path.join(root, "escaped-worker.sh");
		await fs.promises.writeFile(worker, reparentedWorkerScript(readyPipe), { mode: 0o755 });

		// `setsid` moves the intermediate into a new session, then that
		// intermediate backgrounds the worker and exits. The worker is no
		// longer in the resolver shell's PID tree or original process group.
		await expectTimeoutKillsWorker(
			`setsid sh -c '"${worker}" $$ &' </dev/null >/dev/null 2>&1 & sleep 30`,
			readyPipe,
			"session-escaping",
		);
	},
);

test.skipIf(process.platform === "win32")(
	"a timed-out !command hard-kills descendants that ignore SIGTERM",
	async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-config-treekill-term-"));
		roots.push(root);
		const readyPipe = makeReadyPipe(root);
		const worker = path.join(root, "term-ignoring-worker.sh");
		// The ignored TERM disposition survives `exec`, so the reported pid is
		// the `sleep` that must be hard-killed; it would outlive the test.
		await fs.promises.writeFile(worker, `#!/bin/sh\ntrap '' TERM\necho $$ > "${readyPipe}"\nexec sleep 30\n`, {
			mode: 0o755,
		});

		// Parity with the executeShell contract (natives native.test.ts "should
		// SIGKILL workloads that ignore SIGTERM on timeout"): the timeout must
		// hard-kill the whole tree.
		await expectTimeoutKillsWorker(`"${worker}" & sleep 30`, readyPipe, "SIGTERM-ignoring");
	},
);

test.skipIf(process.platform === "win32")("resolves !commands when PATH omits the shell entirely", async () => {
	// A launcher may supply a minimal tool-only PATH; the resolver must still
	// find the OS shell. Probing in a subprocess so the stripped PATH cannot
	// affect this test process's own spawns.
	const script = `import { runShellCommand } from ${JSON.stringify(resolverUrl)};
const value = await runShellCommand("echo pathless-ok", 5_000);
console.log(value === "pathless-ok" ? "PATHLESS-OK" : "PATHLESS-BAD:" + value);`;
	const emptyPathDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-no-sh-in-path-"));
	roots.push(emptyPathDir);
	const proc = Bun.spawn({
		cmd: [process.execPath, "--eval", script],
		cwd: process.cwd(),
		env: { ...Bun.env, PATH: emptyPathDir },
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 15_000,
	});
	const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	expect(exitCode, stdout).toBe(0);
	expect(stdout.trim()).toBe("PATHLESS-OK");
});
