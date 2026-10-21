import { expect, test } from "bun:test";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../../../..");

/** A host process that runs `guest` in-process on a cmux tab and prints how the run failed. */
function probe(guest: string): string {
	return `
import { CmuxTab } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/cmux-tab";
import { runInProcessTab } from "@oh-my-pi/pi-coding-agent/tools/browser/in-process-run";
import { CmuxSocketClient } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/socket-client";

const cwd = process.cwd();
const tab = new CmuxTab({
	client: new CmuxSocketClient({ socketPath: "/tmp/unused-cmux-rejection-probe.sock" }),
	surfaceId: "rejection-probe",
});
const session = { cwd, hasUI: false, getSessionFile: () => null };

try {
	await runInProcessTab(tab, {
		code: ${JSON.stringify(guest)},
		timeoutMs: 10_000,
		session,
		snapshot: { cwd },
	});
	process.stdout.write("unexpected success\\n");
	process.exitCode = 2;
} catch (error) {
	process.stdout.write(\`caught:\${error instanceof Error ? error.message : String(error)}\\n\`);
}
`;
}

async function runProbe(guest: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn([process.execPath, "--eval", probe(guest)], {
		cwd: repoRoot,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

test("cmux guest floating rejection fails the browser run without exiting the host", async () => {
	const { exitCode, stdout, stderr } = await runProbe(`
		const { promise, reject } = Promise.withResolvers();
		reject(new Error("boom"));
		await Bun.file("package.json").text();
		await promise.catch(() => undefined);
	`);

	expect(exitCode, stderr).toBe(0);
	expect(stdout).toBe("caught:Unhandled rejection (missing await?): boom\n");
	expect(stderr).not.toContain("[Unhandled Rejection]");
});

test("cmux guest floating non-Error rejection fails the browser run with its message without exiting the host", async () => {
	// Before: no stack tied the value to the run, so it took the host's fatal unhandled-rejection path.
	const { exitCode, stdout, stderr } = await runProbe(`
		Promise.reject({ message: "m" });
		await Bun.file("package.json").text();
	`);

	expect(exitCode, stderr).toBe(0);
	expect(stdout).toBe("caught:Unhandled rejection (missing await?): m\n");
	expect(stderr).not.toContain("[Unhandled Rejection]");
});
