import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

const CONFLICT = "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> topic\n";

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(block => (block.type === "text" ? (block.text ?? "") : "")).join("\n");
}

async function git(cwd: string, args: string[], exitCode = 0): Promise<void> {
	const result = await $`git ${args}`.cwd(cwd).quiet().nothrow();
	if (result.exitCode !== exitCode) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
}

describe("registered conflicts follow live marker blocks", () => {
	let cwd: string;
	let session: ToolSession;
	let read: ReadTool;
	let write: WriteTool;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "conflict-live-registry-"));
		session = {
			cwd,
			hasUI: false,
			enableLsp: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			settings: Settings.isolated(),
		};
		read = new ReadTool(session);
		write = new WriteTool(session);
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	it("does not report aborted-merge IDs as unlisted after resolving a later real merge", async () => {
		await git(cwd, ["init", "-q", "-b", "main"]);
		for (const [key, value] of Object.entries({
			"user.name": "Test",
			"user.email": "test@example.invalid",
			"commit.gpgsign": "false",
			"core.autocrlf": "false",
			"merge.conflictStyle": "merge",
		})) {
			await git(cwd, ["config", key, value]);
		}
		for (const name of ["a", "b", "c", "d"]) await Bun.write(path.join(cwd, name), "base\n");
		await git(cwd, ["add", "-f", "a", "b", "c", "d"]);
		await git(cwd, ["commit", "-qm", "base"]);
		await git(cwd, ["checkout", "-qb", "merge-a"]);
		for (const name of ["a", "b"]) await Bun.write(path.join(cwd, name), `theirs-a-${name}\n`);
		await git(cwd, ["commit", "-qam", "merge a"]);
		await git(cwd, ["checkout", "-q", "main"]);
		await git(cwd, ["checkout", "-qb", "merge-b"]);
		for (const name of ["c", "d"]) await Bun.write(path.join(cwd, name), `theirs-b-${name}\n`);
		await git(cwd, ["commit", "-qam", "merge b"]);
		await git(cwd, ["checkout", "-q", "main"]);
		for (const name of ["a", "b", "c", "d"]) await Bun.write(path.join(cwd, name), `ours-${name}\n`);
		await git(cwd, ["commit", "-qam", "ours"]);
		await git(cwd, ["merge", "merge-a"], 1);
		await read.execute("merge-a", { path: "./a:conflicts;./b:conflicts" });
		expect(session.conflictHistory?.entries().map(entry => entry.id)).toEqual([1, 2]);

		await git(cwd, ["merge", "--abort"]);
		await git(cwd, ["merge", "merge-b"], 1);
		await read.execute("merge-b", { path: "./c:conflicts;./d:conflicts" });
		const resolved = await write.execute("resolve-b", { path: "conflict://*", content: "3: @theirs\n4: @ours" });

		expect(text(resolved)).toContain("Resolved 2 conflicts across 2 files");
		expect(text(resolved)).not.toContain("unlisted");
		expect(session.conflictHistory?.entries()).toHaveLength(0);
		expect(await Bun.file(path.join(cwd, "c")).text()).toBe("theirs-b-c\n");
		expect(await Bun.file(path.join(cwd, "d")).text()).toBe("ours-d\n");
		await expect(read.execute("old-read", { path: "conflict://1" })).rejects.toThrow(/not found|stale/);
		await expect(write.execute("old-write", { path: "conflict://2", content: "wrong" })).rejects.toThrow(
			/not found|stale/,
		);
		expect(await Bun.file(path.join(cwd, "b")).text()).toBe("ours-b\n");
	});

	it("prunes externally removed markers on a clean ordinary read and a complete summary scan", async () => {
		for (const name of ["ordinary.ts", "summary.ts"]) await Bun.write(path.join(cwd, name), CONFLICT);
		await read.execute("register", { path: "ordinary.ts:conflicts;summary.ts:conflicts" });
		for (const name of ["ordinary.ts", "summary.ts"]) await Bun.write(path.join(cwd, name), "resolved\n");
		await read.execute("ordinary", { path: "ordinary.ts" });
		expect(session.conflictHistory?.get(1)).toBeUndefined();
		await read.execute("summary", { path: "summary.ts:conflicts" });
		expect(session.conflictHistory?.entries()).toHaveLength(0);
	});

	it("rejects cached reads and writes after a block changes instead of rebinding its old ID", async () => {
		const file = path.join(cwd, "changed.ts");
		await Bun.write(file, CONFLICT);
		await read.execute("register-old", { path: "changed.ts:conflicts" });
		const changed = CONFLICT.replace("ours\n", "new-ours\n");
		await Bun.write(file, changed);
		await expect(read.execute("stale-read", { path: "conflict://1" })).rejects.toThrow(/not found|stale|no longer/);
		await read.execute("register-new", { path: "changed.ts:conflicts" });
		expect(session.conflictHistory?.get(1)).toBeUndefined();
		expect(session.conflictHistory?.get(2)?.oursLines).toEqual(["new-ours"]);
		await expect(write.execute("stale-write", { path: "conflict://1", content: "wrong" })).rejects.toThrow(
			/not found|stale/,
		);
		expect(await Bun.file(file).text()).toBe(changed);
	});

	it("replaces a file's registration set when a new block occupies the same source line", async () => {
		const file = path.join(cwd, "new-generation.ts");
		await Bun.write(file, CONFLICT);
		await read.execute("old-generation", { path: "new-generation.ts:conflicts" });
		await Bun.write(file, CONFLICT.replace("theirs\n", "new-theirs\n"));
		await read.execute("new-generation", { path: "new-generation.ts:conflicts" });
		expect(session.conflictHistory?.entries().map(entry => entry.id)).toEqual([2]);
		await expect(write.execute("old-generation-write", { path: "conflict://1", content: "wrong" })).rejects.toThrow(
			/not found|stale/,
		);
	});

	it("keeps an unchanged shifted block's ID and updates its displayed source coordinates", async () => {
		const file = path.join(cwd, "shift.ts");
		await Bun.write(file, CONFLICT);
		await read.execute("register", { path: "shift.ts:conflicts" });
		await Bun.write(file, `new header\n${CONFLICT}`);
		await read.execute("reregister", { path: "shift.ts:conflicts" });
		expect(session.conflictHistory?.entries().map(entry => entry.id)).toEqual([1]);
		expect(session.conflictHistory?.get(1)?.startLine).toBe(2);
		await write.execute("resolve", { path: "conflict://1", content: "@theirs" });
		expect(await Bun.file(file).text()).toBe("new header\ntheirs\n");
	});

	it("prunes deleted files at conflict read and bulk boundaries", async () => {
		const file = path.join(cwd, "deleted.ts");
		await Bun.write(file, CONFLICT);
		await read.execute("register", { path: "deleted.ts:conflicts" });
		await fs.unlink(file);
		await expect(read.execute("deleted", { path: "conflict://1" })).rejects.toThrow(/not found|no longer/);
		expect(session.conflictHistory?.entries()).toHaveLength(0);
		await expect(write.execute("empty-bulk", { path: "conflict://*", content: "@ours" })).rejects.toThrow(
			/nothing to resolve/,
		);
		await Bun.write(file, CONFLICT);
		await read.execute("register-again", { path: "deleted.ts:conflicts" });
		await fs.unlink(file);
		await expect(write.execute("deleted-bulk", { path: "conflict://*", content: "@ours" })).rejects.toThrow(
			/nothing to resolve/,
		);
		expect(session.conflictHistory?.entries()).toHaveLength(0);
	});

	it("counts only genuinely live unlisted IDs in a subset directive result", async () => {
		for (const name of ["a.ts", "b.ts", "c.ts"]) await Bun.write(path.join(cwd, name), CONFLICT);
		await read.execute("register", { path: "a.ts:conflicts;b.ts:conflicts;c.ts:conflicts" });
		await Bun.write(path.join(cwd, "a.ts"), "resolved externally\n");
		const result = await write.execute("subset", { path: "conflict://*", content: "2: @ours" });
		expect(text(result)).toContain("1 unlisted conflict still registered (#3)");
		expect(session.conflictHistory?.entries().map(entry => entry.id)).toEqual([3]);
	});

	it("does not prune a registered block beyond a capped scan's coverage", async () => {
		const filler = `${"x".repeat(1023)}\n`.repeat(10_240);
		const file = path.join(cwd, "capped.ts");
		await Bun.write(file, `${filler}${CONFLICT}`);
		await read.execute("register-tail", { path: "capped.ts:10241-" });
		expect(session.conflictHistory?.get(1)?.startLine).toBe(10241);
		await read.execute("capped-summary", { path: "capped.ts:conflicts" });
		expect(session.conflictHistory?.get(1)?.startLine).toBe(10241);
		await write.execute("resolve-tail", { path: "conflict://1", content: "@ours" });
		expect(await Bun.file(file).text()).toBe(`${filler}ours\n`);
	});
});
