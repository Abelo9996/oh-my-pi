import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getEditStore } from "@oh-my-pi/pi-coding-agent/edit/store";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const THEIRS = Array.from({ length: 30 }, (_, index) => `theirs-${index + 1}`);
const LINES = [
	"header",
	"context",
	"<<<<<<< HEAD",
	"ours-1",
	"ours-2",
	"||||||| ancestor",
	"base-1",
	"base-2",
	"=======",
	...THEIRS,
	">>>>>>> topic",
	"tail",
];
const THEIRS_START = LINES.indexOf("theirs-1") + 1;

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(block => (block.type === "text" ? (block.text ?? "") : "")).join("\n");
}

describe("conflict URI read selectors", () => {
	let cwd: string;
	let file: string;
	let session: ToolSession;
	let read: ReadTool;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "conflict-uri-selectors-"));
		file = path.join(cwd, "sides.txt");
		await Bun.write(file, LINES.join("\n"));
		session = {
			cwd,
			hasUI: false,
			enableLsp: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			settings: Settings.isolated({ "edit.mode": "hashline" }),
		};
		read = new ReadTool(session);
		await read.execute("register", { path: "sides.txt:conflicts" });
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	it("reads the whole block and each side raw without adding display prefixes", async () => {
		for (const [scope, expected] of [
			["", LINES.slice(2, -1).join("\n")],
			["/ours", "ours-1\nours-2"],
			["/base", "base-1\nbase-2"],
			["/theirs", THEIRS.join("\n")],
		]) {
			expect(text(await read.execute("raw-side", { path: `conflict://1${scope}:raw` }))).toBe(expected!);
		}
	});

	it("pages relative to the side while displaying original source line numbers only once", async () => {
		const result = await read.execute("head", { path: "conflict://1/theirs:1-3" });
		const output = text(result);
		// Ordinary non-raw bounded ranges include three trailing context lines.
		expect([...output.matchAll(/^(\d+):/gm)].map(match => Number(match[1]))).toEqual(
			Array.from({ length: 6 }, (_, index) => THEIRS_START + index),
		);
		expect(output).not.toMatch(/^\d+:\d+:/m);
		expect(output.match(/^\[sides\.txt#/gm)).toHaveLength(1);
		expect(result.details?.displayContent?.lineNumbers).toEqual(
			Array.from({ length: 6 }, (_, index) => THEIRS_START + index),
		);
		const tag = output.match(/^\[sides\.txt#([^\]]+)\]/m)?.[1];
		expect(tag).toBeDefined();
		expect(getEditStore(session).byHashText(file, tag!)).toBe(LINES.join("\n"));
	});

	it("accepts head, tail and comma ranges with raw in either position", async () => {
		for (const [selector, expected] of [
			["1-3:raw", THEIRS.slice(0, 3).join("\n")],
			["raw:-20", THEIRS.slice(-20).join("\n")],
			["-2:raw", THEIRS.slice(-2).join("\n")],
			["raw:2-3,28-29", `${THEIRS.slice(1, 3).join("\n")}\n\n…\n\n${THEIRS.slice(27, 29).join("\n")}`],
		]) {
			expect(text(await read.execute("raw-range", { path: `conflict://1/theirs:${selector}` }))).toBe(expected!);
		}
	});

	it("keeps source provenance for tail and disjoint non-raw ranges", async () => {
		const tail = await read.execute("tail", { path: "conflict://1/theirs:-2" });
		expect(tail.details?.displayContent?.lineNumbers).toEqual([
			THEIRS_START + 27,
			THEIRS_START + 28,
			THEIRS_START + 29,
		]);
		const comma = await read.execute("comma", { path: "conflict://1/theirs:2-3,28-29" });
		expect(comma.details?.displayContent?.lineNumbers).toEqual([
			THEIRS_START + 1,
			THEIRS_START + 2,
			null,
			THEIRS_START + 27,
			THEIRS_START + 28,
		]);
	});

	it("reports bounds relative to the selected body and still rejects unknown scopes", async () => {
		expect(text(await read.execute("out-of-bounds", { path: "conflict://1/theirs:40-42" }))).toContain(
			"Line 40 is beyond end of resource (30 lines total)",
		);
		await expect(read.execute("unknown-scope", { path: "conflict://1/unknown:1-3" })).rejects.toThrow(
			/scope must be one of/,
		);
	});

	it("does not turn read ranges into write scopes or change per-id directive parsing", async () => {
		const write = new WriteTool(session);
		await expect(
			write.execute("write-range", { path: "conflict://1/theirs:1-3", content: "replacement" }),
		).rejects.toThrow();
		expect(await Bun.file(file).text()).toBe(LINES.join("\n"));
		await write.execute("directives", { path: "conflict://*", content: "1: @theirs" });
		expect(await Bun.file(file).text()).toBe(["header", "context", ...THEIRS, "tail"].join("\n"));
	});
});
