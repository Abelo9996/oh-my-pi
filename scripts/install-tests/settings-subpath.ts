import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const cli = process.argv.slice(2).map(arg => (arg.includes("/") ? path.resolve(arg) : arg));
assert(cli.length > 0, "Usage: bun scripts/install-tests/settings-subpath.ts <cli> [cli entrypoint]");
const work = await fs.mkdtemp(path.join(os.tmpdir(), "omp-settings-subpath-"));
const extensionPath = path.join(work, "probe.mjs");
const resultPath = path.join(work, "result.json");

try {
	await fs.mkdir(path.join(work, "project"));
	await Bun.write(
		extensionPath,
		`import { cfgAutolearnEnabled } from "@oh-my-pi/pi-coding-agent/autolearn/settings";
const resultPath = ${JSON.stringify(resultPath)};
export default function (pi) {
	pi.registerCommand("settings-subpath-smoke", {
		handler: async (_args, ctx) => {
			const before = cfgAutolearnEnabled.get(pi.pi.settings);
			cfgAutolearnEnabled.override(pi.pi.settings, true);
			await Bun.write(resultPath, JSON.stringify([before, cfgAutolearnEnabled.get(pi.pi.settings)]));
			ctx.shutdown();
		},
	});
}
`,
	);
	const child = Bun.spawn(
		[
			...cli,
			"--no-extensions",
			"--extension",
			extensionPath,
			"--no-session",
			"--no-tools",
			"--no-lsp",
			"--no-skills",
			"--no-rules",
			"--no-title",
			"--model",
			"openai/gpt-4o",
			"--print",
			"/settings-subpath-smoke",
		],
		{
			cwd: path.join(work, "project"),
			env: {
				PATH: process.env.PATH,
				HOME: path.join(work, "home"),
				XDG_DATA_HOME: path.join(work, "xdg"),
				PI_CODING_AGENT_DIR: path.join(work, "agent"),
				OPENAI_API_KEY: "offline-fixture-key",
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			timeout: 30_000,
		},
	);
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	assert.equal(exitCode, 0, `Settings subpath extension failed (${exitCode})\n${stdout}\n${stderr}`);
	const result = await Bun.file(resultPath)
		.json()
		.catch(error => {
			throw new Error(`Settings subpath handler did not run\n${stdout}\n${stderr}`, { cause: error });
		});
	assert.deepEqual(result, [false, true]);
	console.log("Installed CLI settings subpath smoke passed");
} finally {
	await fs.rm(work, { recursive: true, force: true });
}
