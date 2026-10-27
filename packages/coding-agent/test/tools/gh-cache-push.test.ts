import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as bashExecutor from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import type { BashResult } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { ClientBridge } from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { getOrFetchPrDiff } from "@oh-my-pi/pi-coding-agent/tools/gh-pr-diff";
import {
	getCached,
	putCached,
	resetForTests,
	resolveGithubCacheAuthKey,
} from "@oh-my-pi/pi-coding-agent/tools/github-cache";
import { github } from "@oh-my-pi/pi-coding-agent/utils/github";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { $ } from "bun";

const REPO = "owner/example";
let cwd: string;
let originalDb: string | undefined;
let originalToken: string | undefined;
let manager: AsyncJobManager;

function diff(file: string): string {
	return `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n+new\n`;
}

function completed(exitCode = 0): BashResult {
	return {
		output: "",
		exitCode,
		cancelled: false,
		truncated: false,
		totalLines: 0,
		totalBytes: 0,
		outputLines: 0,
		outputBytes: 0,
	};
}

function session(bridge?: ClientBridge): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionId: () => cwd,
		getSessionSpawns: () => "*",
		asyncJobManager: manager,
		getClientBridge: () => bridge,
		settings: Settings.isolated({
			"bash.autoBackground.enabled": false,
			"bashInterceptor.enabled": false,
			"bash.direnv": "off",
		}),
	};
}

function seed(repo = REPO, authKey = resolveGithubCacheAuthKey()): void {
	for (const includeComments of [false, true]) {
		putCached({ repo, authKey, kind: "pr", number: 7, includeComments, payload: { head: "A" }, rendered: "head A" });
	}
}

beforeEach(async () => {
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gh-cache-push-"));
	await $`git init -b main ${cwd}`.quiet();
	const repository = vcs.requireGit(cwd);
	await repository.remoteAdd("origin", "git@github.com:owner/example.git");
	await repository.remoteAdd("fork", "https://github.com/contributor/example.git");
	originalDb = process.env.OMP_GITHUB_CACHE_DB;
	originalToken = process.env.GH_TOKEN;
	process.env.OMP_GITHUB_CACHE_DB = path.join(cwd, "cache.db");
	process.env.GH_TOKEN = "push-cache-test";
	resetForTests();
	InternalUrlRouter.resetForTests();
	manager = new AsyncJobManager({});
});

afterEach(async () => {
	await manager.dispose();
	vi.restoreAllMocks();
	resetForTests();
	InternalUrlRouter.resetForTests();
	if (originalDb === undefined) delete process.env.OMP_GITHUB_CACHE_DB;
	else process.env.OMP_GITHUB_CACHE_DB = originalDb;
	if (originalToken === undefined) delete process.env.GH_TOKEN;
	else process.env.GH_TOKEN = originalToken;
	await fs.rm(cwd, { recursive: true, force: true });
});

describe("bash git push cache invalidation", () => {
	it("fetches the new file set inside the TTL and shares it across listing, full diff and slices", async () => {
		const oldDiff = diff("old.ts");
		const newDiff = oldDiff + diff("added.ts");
		const text = vi.spyOn(github, "text").mockResolvedValue(oldDiff);
		const router = InternalUrlRouter.instance();
		const frozen = await getOrFetchPrDiff({ cwd, repo: REPO, number: 7 });
		await router.resolve("pr://owner/example/7/diff");
		seed();
		seed(REPO, "other-credential");
		seed("unrelated/example");
		putCached({ repo: REPO, kind: "issue", number: 7, includeComments: false, payload: {}, rendered: "issue" });
		text.mockResolvedValue(newDiff);
		vi.spyOn(bashExecutor, "executeBash").mockResolvedValue(completed());

		await new BashTool(session()).execute("push", { command: "git push" });

		for (const authKey of [resolveGithubCacheAuthKey(), "other-credential"]) {
			for (const includeComments of [false, true]) {
				expect(getCached(REPO, "pr", 7, includeComments, authKey)).toBeNull();
			}
		}
		expect(getCached("unrelated/example", "pr", 7, true, resolveGithubCacheAuthKey())?.rendered).toBe("head A");
		expect(getCached(REPO, "issue", 7, false)?.rendered).toBe("issue");
		const listing = await router.resolve("pr://owner/example/7/diff");
		const full = await router.resolve("pr://owner/example/7/diff/all");
		const slice = await router.resolve("pr://owner/example/7/diff/2");
		expect(listing.content).toContain("added.ts");
		expect(full.content).toBe(newDiff);
		expect(slice.content).toBe(diff("added.ts"));
		expect(text).toHaveBeenCalledTimes(2);
		expect(frozen.payload.unified).toBe(oldDiff);
		expect(frozen.payload.files.map(file => file.path)).toEqual(["old.ts"]);
	});

	it("waits for successful completion before dropping the live row", async () => {
		seed();
		const pending = Promise.withResolvers<BashResult>();
		const started = Promise.withResolvers<void>();
		vi.spyOn(bashExecutor, "executeBash").mockImplementation(() => {
			started.resolve();
			return pending.promise;
		});
		const execution = new BashTool(session()).execute("push", { command: "git push origin main" });
		await started.promise;
		expect(getCached(REPO, "pr", 7, true, resolveGithubCacheAuthKey())?.rendered).toBe("head A");
		pending.resolve(completed());
		await execution;
		expect(getCached(REPO, "pr", 7, true, resolveGithubCacheAuthKey())).toBeNull();
	});

	it("does not let an in-flight pre-push diff overwrite the new generation", async () => {
		const old = Promise.withResolvers<string>();
		const started = Promise.withResolvers<void>();
		const text = vi.spyOn(github, "text").mockImplementation(() => {
			started.resolve();
			return old.promise;
		});
		const pending = getOrFetchPrDiff({ cwd, repo: REPO, number: 7 });
		await started.promise;
		vi.spyOn(bashExecutor, "executeBash").mockResolvedValue(completed());
		await new BashTool(session()).execute("push", { command: "git push" });
		text.mockResolvedValue(diff("added.ts"));
		await getOrFetchPrDiff({ cwd, repo: REPO, number: 7 });
		old.resolve(diff("old.ts"));
		await pending;
		const current = await getOrFetchPrDiff({ cwd, repo: REPO, number: 7 });
		expect(current.payload.files.map(file => file.path)).toEqual(["added.ts"]);
		expect(text).toHaveBeenCalledTimes(2);
	});

	it.each([
		{ command: "git push", exitCode: 1 },
		{ command: "git push --dry-run", exitCode: 0 },
		{ command: "git push -n origin main", exitCode: 0 },
		{ command: "git push origin main --dry-run", exitCode: 0 },
		{ command: "git push || true", exitCode: 0 },
		{ command: "echo git push", exitCode: 0 },
	])("keeps cached rows when $command does not establish a successful push", async ({ command, exitCode }) => {
		seed();
		vi.spyOn(bashExecutor, "executeBash").mockResolvedValue(completed(exitCode));
		await new BashTool(session()).execute("not-pushed", { command });
		expect(getCached(REPO, "pr", 7, true, resolveGithubCacheAuthKey())?.rendered).toBe("head A");
	});

	it.each([
		{ command: "git push fork HEAD:main", config: [] },
		{ command: "git push --repo=fork HEAD:main", config: [] },
		{ command: "git push https://github.com/contributor/example.git HEAD:main", config: [] },
		{ command: "git push", config: [["branch.main.remote", "fork"]] },
		{
			command: "git push",
			config: [
				["branch.main.remote", "origin"],
				["remote.pushDefault", "fork"],
			],
		},
		{
			command: "git push",
			config: [
				["remote.pushDefault", "origin"],
				["branch.main.pushRemote", "fork"],
			],
		},
		{
			command: "git push origin main",
			config: [["remote.origin.pushurl", "https://github.com/contributor/example.git"]],
		},
	])("invalidates only the actual destination for $command with $config", async ({ command, config }) => {
		for (const [key, value] of config) await vcs.requireGit(cwd).configSet(key!, value!);
		seed();
		seed("contributor/example");
		vi.spyOn(bashExecutor, "executeBash").mockResolvedValue(completed());
		await new BashTool(session()).execute("fork-push", { command });
		expect(getCached("contributor/example", "pr", 7, true, resolveGithubCacheAuthKey())).toBeNull();
		expect(getCached(REPO, "pr", 7, true, resolveGithubCacheAuthKey())?.rendered).toBe("head A");
	});

	it("resolves repeated git -C arguments relative to the previous directory", async () => {
		const outer = path.join(cwd, "outer");
		await fs.mkdir(outer);
		seed();
		vi.spyOn(bashExecutor, "executeBash").mockResolvedValue(completed());
		await new BashTool(session()).execute("other-cwd", {
			command: `git -C ${JSON.stringify(outer)} -C .. push origin HEAD:main`,
			cwd: os.tmpdir(),
		});
		expect(getCached(REPO, "pr", 7, true, resolveGithubCacheAuthKey())).toBeNull();
	});

	it("uses the only remote when it is not named origin", async () => {
		await Bun.write(
			path.join(cwd, ".git", "config"),
			'[core]\n\trepositoryformatversion = 0\n\tbare = false\n[remote "only"]\n\turl = https://github.com/owner/example.git\n',
		);
		seed();
		vi.spyOn(bashExecutor, "executeBash").mockResolvedValue(completed());
		await new BashTool(session()).execute("single-remote", { command: "git push" });
		expect(getCached(REPO, "pr", 7, true, resolveGithubCacheAuthKey())).toBeNull();
	});

	it("recognizes a push in a literal successful and-chain", async () => {
		seed();
		vi.spyOn(bashExecutor, "executeBash").mockResolvedValue(completed());
		await new BashTool(session()).execute("and-chain", { command: "git add . && git push origin main" });
		expect(getCached(REPO, "pr", 7, true, resolveGithubCacheAuthKey())).toBeNull();
	});

	it("keeps same-slug caches on other hosts when pushing an enterprise remote", async () => {
		await vcs.requireGit(cwd).remoteAdd("enterprise", "ssh://git@ghe.example.com/owner/example.git");
		seed();
		seed("ghe.example.com/owner/example");
		vi.spyOn(bashExecutor, "executeBash").mockResolvedValue(completed());
		await new BashTool(session()).execute("enterprise-push", { command: "git push enterprise main" });
		expect(getCached("ghe.example.com/owner/example", "pr", 7, true, resolveGithubCacheAuthKey())).toBeNull();
		expect(getCached(REPO, "pr", 7, true, resolveGithubCacheAuthKey())?.rendered).toBe("head A");
	});

	it("invalidates when an asynchronous push completes rather than when it is dispatched", async () => {
		seed();
		const pending = Promise.withResolvers<BashResult>();
		vi.spyOn(bashExecutor, "executeBash").mockReturnValue(pending.promise);
		const result = await new BashTool(session()).execute("background-push", { command: "git push", async: true });
		expect(result.details?.async?.state).toBe("running");
		expect(getCached(REPO, "pr", 7, true, resolveGithubCacheAuthKey())?.rendered).toBe("head A");
		pending.resolve(completed());
		await manager.waitForAll();
		expect(getCached(REPO, "pr", 7, true, resolveGithubCacheAuthKey())).toBeNull();
	});

	it("invalidates a successful push from the client terminal route", async () => {
		seed();
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => ({
				terminalId: "push-terminal",
				waitForExit: async () => ({ exitCode: 0, signal: null }),
				currentOutput: async () => ({ output: "", truncated: false }),
				kill: async () => {},
				release: async () => {},
			}),
		};
		await new BashTool(session(bridge)).execute("terminal-push", { command: "git push" });
		expect(getCached(REPO, "pr", 7, true, resolveGithubCacheAuthKey())).toBeNull();
	});
});
