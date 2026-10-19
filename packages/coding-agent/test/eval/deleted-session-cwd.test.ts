import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { disposeAllKernelSessions, executePython } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import { getSafeProjectCwd, TempDir } from "@oh-my-pi/pi-utils";

// A session cwd removed mid-session (e.g. a merged worktree) must not make eval
// unusable: kernels start from an existing directory and keep serving (#16376).
describe("eval with a deleted session cwd", () => {
	afterAll(async () => {
		await disposeAllKernelSessions();
	});

	it("starts a fresh Python kernel from a fallback directory", async () => {
		using tempDir = TempDir.createSync("@eval-deleted-cwd-fresh-");
		const cwd = path.join(tempDir.path(), "worktree");
		fs.mkdirSync(cwd);
		fs.rmSync(cwd, { recursive: true });

		const result = await executePython("import os\nprint(os.getcwd())", {
			cwd,
			sessionId: "deleted-cwd-fresh",
			kernelMode: "session",
		});

		expect(result.exitCode, result.output).toBe(0);
		expect(result.output.trim()).toBe(fs.realpathSync(getSafeProjectCwd(cwd)));
	});

	it("moves a live Python kernel to the fallback directory once its session cwd is removed", async () => {
		using tempDir = TempDir.createSync("@eval-deleted-cwd-live-");
		const cwd = path.join(tempDir.path(), "worktree");
		fs.mkdirSync(cwd);
		const options = { cwd, sessionId: "deleted-cwd-live", kernelMode: "session" as const };

		expect((await executePython("retained = 41", options)).exitCode).toBe(0);
		fs.rmSync(cwd, { recursive: true });
		const result = await executePython("import os\nprint(retained + 1)\nprint(os.getcwd())", options);

		expect(result.exitCode, result.output).toBe(0);
		expect(result.output.trim().split("\n")).toEqual(["42", fs.realpathSync(getSafeProjectCwd(cwd))]);
	});

	it("spawns hosted workers from an existing directory once the process cwd is deleted", async () => {
		using tempDir = TempDir.createSync("@eval-deleted-cwd-worker-");
		const cwd = path.join(tempDir.path(), "worktree");
		fs.mkdirSync(cwd);
		const workerClient = path.resolve(import.meta.dir, "../../src/subprocess/worker-client.ts");
		const workerHost = path.resolve(import.meta.dir, "../../../utils/src/worker-host.ts");
		// A compiled omp binary refuses to start in a deleted cwd ("The current
		// working directory was deleted"), so the JS eval subprocess must not
		// inherit one.
		const script = [
			'import * as fs from "node:fs";',
			`import { declareWorkerHostEntry } from ${JSON.stringify(workerHost)};`,
			`import { resolveWorkerSpawnCmd } from ${JSON.stringify(workerClient)};`,
			"declareWorkerHostEntry();",
			"fs.rmSync(process.cwd(), { recursive: true });",
			'const { cwd } = resolveWorkerSpawnCmd("__omp_worker_probe");',
			"process.stdout.write(JSON.stringify({ isDirectory: cwd ? fs.statSync(cwd).isDirectory() : false }));",
		].join("\n");
		const proc = Bun.spawn([process.execPath, "--eval", script], { cwd, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		expect(exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout).isDirectory).toBe(true);
	});
});
