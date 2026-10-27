import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const CONFLICT = "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> topic\n";

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(block => (block.type === "text" ? (block.text ?? "") : "")).join("\n");
}

describe("read conflict-selector path lists", () => {
	let cwd: string;
	let session: ToolSession;
	let read: ReadTool;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "conflict-path-list-"));
		session = {
			cwd,
			hasUI: false,
			enableLsp: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			settings: Settings.isolated(),
		};
		read = new ReadTool(session);
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	it("fans out an overlong joined filename and registers each file's conflicts", async () => {
		const names = [`a-${"x".repeat(130)}.ts`, `b-${"y".repeat(130)}.ts`];
		for (const name of names) await Bun.write(path.join(cwd, name), CONFLICT);
		const result = await read.execute("long-list", { path: names.map(name => `${name}:conflicts`).join(";") });

		expect(text(result)).toContain("interpreted as 2 paths");
		for (const [index, name] of names.entries()) {
			expect(text(result)).toContain(`1 unresolved conflict in ${name}`);
			expect(session.conflictHistory?.get(index + 1)?.absolutePath).toBe(path.join(cwd, name));
		}
	});

	it("preserves ENAMETOOLONG for a single filename instead of recovering it as missing", async () => {
		await expect(read.execute("long-single", { path: `${"x".repeat(260)}.ts` })).rejects.toMatchObject({
			code: "ENAMETOOLONG",
		});
	});

	it("retains short conflict and ordinary range selectors on their own targets", async () => {
		await Bun.write(path.join(cwd, "a.ts"), CONFLICT);
		await Bun.write(path.join(cwd, "b.txt"), "first\nsecond\nthird\n");
		const result = await read.execute("mixed-list", { path: "a.ts:conflicts;b.txt:2-2:raw" });

		expect(text(result)).toContain("1 unresolved conflict in a.ts");
		expect(text(result)).toContain("second");
		expect(text(result)).not.toContain("third");
		expect(session.conflictHistory?.entries()).toHaveLength(1);
	});

	it("lists and registers both members of a short conflict-selector list", async () => {
		for (const name of ["a.ts", "b.ts"]) await Bun.write(path.join(cwd, name), CONFLICT);
		const result = await read.execute("short-list", { path: "a.ts:conflicts;b.ts:conflicts" });

		expect(text(result)).toContain("1 unresolved conflict in a.ts");
		expect(text(result)).toContain("1 unresolved conflict in b.ts");
		expect(session.conflictHistory?.entries().map(entry => entry.displayPath)).toEqual(["a.ts", "b.ts"]);
	});

	it("keeps a literal semicolon filename ahead of list fan-out", async () => {
		await Bun.write(path.join(cwd, "a;b.ts"), CONFLICT);
		await Bun.write(path.join(cwd, "a"), "not the target\n");
		await Bun.write(path.join(cwd, "b.ts"), "not the target\n");
		const result = await read.execute("literal", { path: "a;b.ts:conflicts" });

		expect(text(result)).not.toContain("interpreted as");
		expect(session.conflictHistory?.get(1)?.absolutePath).toBe(path.join(cwd, "a;b.ts"));
	});

	it("reports a missing list member without discarding another member's conflicts", async () => {
		await Bun.write(path.join(cwd, "a.ts"), CONFLICT);
		const result = await read.execute("missing-member", { path: "a.ts:conflicts;missing.ts:conflicts" });

		expect(text(result)).toContain("1 unresolved conflict in a.ts");
		expect(text(result)).toContain("missing.ts");
		expect(text(result)).toContain("not found");
		expect(session.conflictHistory?.entries()).toHaveLength(1);
	});

	it("surfaces permission errors instead of interpreting them as missing list targets", async () => {
		const denied = path.join(cwd, "denied");
		await Bun.write(path.join(denied, "a.ts"), CONFLICT);
		await Bun.write(path.join(cwd, "b.ts"), CONFLICT);
		await fs.chmod(denied, 0);
		try {
			await expect(read.execute("denied-list", { path: "denied/a.ts:conflicts;b.ts:conflicts" })).rejects.toThrow(
				/EACCES|permission denied/i,
			);
			expect(session.conflictHistory?.entries() ?? []).toHaveLength(0);
		} finally {
			await fs.chmod(denied, 0o700);
		}
	});
});
