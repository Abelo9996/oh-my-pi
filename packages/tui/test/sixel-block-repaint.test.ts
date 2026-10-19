import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as natives from "@oh-my-pi/pi-natives";
import { TUI } from "@oh-my-pi/pi-tui";
import { Image, renderForScrollback } from "@oh-my-pi/pi-tui/components/image";
import { Text } from "@oh-my-pi/pi-tui/components/text";
import {
	type CellDimensions,
	getCellDimensions,
	ImageProtocol,
	setCellDimensions,
	setTerminalImageProtocol,
	TERMINAL,
} from "@oh-my-pi/pi-tui/terminal-capabilities";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";

withoutTerminalMultiplexer();

import { VirtualTerminal } from "./virtual-terminal";

const BASE64_ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";
const CELL: CellDimensions = { widthPx: 10, heightPx: 20 };
const RASTER = "▓";
const SIXEL = /\x1bP[0-9;]*q[\s\S]*?\x1b\\/g;

/** Execute SIXEL bands at pixel resolution, including repeated runs and color rewinds. */
function sixelPixels(sequence: string): string[][] {
	const raster = /q"\d+;\d+;(\d+);(\d+)/.exec(sequence)!;
	const pixels = Array.from({ length: Number(raster[2]) }, () => Array<string>(Number(raster[1])).fill(""));
	let color = "0";
	let x = 0;
	let y = 0;
	for (const match of sequence
		.slice(raster.index + raster[0].length, -2)
		.matchAll(/#(\d+)(;[12];\d+;\d+;\d+)?|!(\d+)([?-~])|[?-~$-]/g)) {
		if (match[1] !== undefined) color = match[1];
		else if (match[0] === "$") x = 0;
		else if (match[0] === "-") {
			y += 6;
			x = 0;
		} else {
			const bits = (match[4] ?? match[0]).charCodeAt(0) - 63;
			const count = match[3] ? Number(match[3]) : 1;
			for (let column = 0; column < count; column++, x++) {
				for (let bit = 0; bit < 6; bit++) {
					if (!(bits & (1 << bit))) continue;
					pixels[y + bit] ??= Array<string>(Number(raster[1])).fill("");
					pixels[y + bit]![x] = color;
				}
			}
		}
	}
	return pixels;
}

function solidSixel(width: number, height: number): string {
	return `\x1bP0;1q"1;1;${width};${height}#1;2;100;0;0${Array.from(
		{ length: Math.ceil(height / 6) },
		(_, row) => `!${width}${String.fromCharCode(63 + (1 << Math.min(6, height - row * 6)) - 1)}`,
	).join("-")}\x1b\\`;
}

/**
 * Model a transparent SIXEL raster over the real terminal text grid. Painting
 * uses CUP to restore the cursor: ESC 7/8 would overwrite the renderer's
 * saved image origin and make the test observe a different cursor from reality.
 */
function trackSixelRaster(term: VirtualTerminal): {
	stale: number;
	paints: number;
	scrolls: number;
	pixelRows: number[];
} {
	const state = { stale: 0, paints: 0, scrolls: 0, pixelRows: [] as number[] };
	const realWrite = term.write.bind(term);
	vi.spyOn(term, "write").mockImplementation((data: string) => {
		let offset = 0;
		for (const match of data.matchAll(SIXEL)) {
			realWrite(data.slice(offset, match.index));
			offset = match.index + match[0].length;
			const cursor = term.getCursor();
			const pixels = sixelPixels(match[0]);
			const bands = 1 + [...match[0].matchAll(/-/g)].length;
			const allocatedPixels = Math.max(12, bands * 6);
			const overflow = allocatedPixels - (term.rows - cursor.row) * CELL.heightPx;
			const scrolls = Math.max(0, Math.ceil(overflow / CELL.heightPx));
			if (scrolls > 0) {
				state.scrolls += scrolls;
				realWrite(`\x1b[${term.rows};1H${"\n".repeat(scrolls)}`);
			}
			const originRow = cursor.row - scrolls;
			const screen = term.getViewport();
			const cells = new Map<number, Set<number>>();
			state.pixelRows = [];
			for (let y = 0; y < pixels.length; y++) {
				const screenPixel = originRow * CELL.heightPx + y;
				if (screenPixel < 0 || screenPixel >= term.rows * CELL.heightPx) continue;
				if (pixels[y]!.some(Boolean)) state.pixelRows.push(screenPixel);
				for (let x = 0; x < pixels[y]!.length; x++) {
					if (!pixels[y]![x]) continue;
					const row = Math.floor(screenPixel / CELL.heightPx);
					let columns = cells.get(row);
					if (!columns) cells.set(row, (columns = new Set()));
					columns.add(cursor.col + Math.floor(x / CELL.widthPx));
				}
			}
			let paint = "";
			for (const [row, columns] of cells) {
				for (const column of columns) {
					if (screen[row]?.[column] === RASTER) state.stale++;
					paint += `\x1b[${row + 1};${column + 1}H${RASTER}`;
				}
			}
			state.paints++;
			realWrite(`${paint}\x1b[${cursor.row + 1};${cursor.col + 1}H`);
		}
		realWrite(data.slice(offset));
	});
	return state;
}

describe("SIXEL block repaint", () => {
	let originalCellDims: CellDimensions;
	const originalProtocol = TERMINAL.imageProtocol;

	beforeEach(() => {
		originalCellDims = { ...getCellDimensions() };
		setCellDimensions(CELL);
		setTerminalImageProtocol(ImageProtocol.Sixel);
		vi.useFakeTimers();
		// One full 30fps frame per read: the render throttle never defers a frame.
		let now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => (now += 40));
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		setCellDimensions(originalCellDims);
		setTerminalImageProtocol(originalProtocol);
	});

	/** Run the `setImmediate` render hop and any throttled frame timer it arms. */
	async function settle(term: VirtualTerminal): Promise<void> {
		for (let i = 0; i < 2; i++) {
			const turn = Promise.withResolvers<void>();
			setImmediate(turn.resolve);
			await turn.promise;
			vi.advanceTimersByTime(40);
			await term.flush();
		}
	}

	function deterministicSixel(): void {
		spyOn(natives, "encodeSixelAsync").mockImplementation(async (_data, width, height) => solidSixel(width, height));
		spyOn(natives, "encodeSixel").mockImplementation((_data, width, height) => solidSixel(width, height));
	}

	function graphic(tui: TUI, key: string, rows = 4): Image {
		return new Image(
			BASE64_ONE_PIXEL_PNG,
			"image/png",
			{ fallbackColor: text => text },
			{ maxWidthCells: 4, maxHeightCells: rows, budget: tui.imageBudget, imageKey: key },
			{ widthPx: 40, heightPx: rows * CELL.heightPx },
		);
	}

	it("erases a moved block's previous raster before painting it again", async () => {
		const encodeSixel = spyOn(natives, "encodeSixelAsync");
		const term = new VirtualTerminal(40, 12);
		const raster = trackSixelRaster(term);
		const tui = new TUI(term);
		const above = new Text("above", 0, 0);
		tui.addChild(above);
		tui.addChild(
			new Image(
				BASE64_ONE_PIXEL_PNG,
				"image/png",
				{ fallbackColor: t => t },
				{ maxWidthCells: 4, maxHeightCells: 4, budget: tui.imageBudget, imageKey: "moving" },
				{ widthPx: 40, heightPx: 80 },
			),
		);
		tui.addChild(new Text("below", 0, 0));
		try {
			tui.start();
			await settle(term);
			await encodeSixel.mock.results[0]?.value;
			await settle(term);
			// Each frame moves the block one row inside the viewport: a diffable
			// frame in which its reserved rows are byte-identical and skipped.
			for (const text of ["above\nextra", "above", "above\nextra", "above"]) {
				above.setText(text);
				tui.requestRender();
				await settle(term);
			}
			expect(raster.paints).toBe(5);
			expect(raster.stale).toBe(0);
			// Back on rows 1..4: exactly one raster, nothing left behind.
			const rasterRows = term.getViewport().flatMap((line, row) => (line.includes(RASTER) ? [row] : []));
			expect(rasterRows).toEqual([1, 2, 3, 4]);
		} finally {
			tui.stop();
		}
	});

	it("bounds forced SIXEL repaints below committed history without scrolling on a partial bottom band", async () => {
		deterministicSixel();
		const term = new VirtualTerminal(40, 12);
		const raster = trackSixelRaster(term);
		const tui = new TUI(term);
		const image = graphic(tui, "clipped");
		const history = Array.from({ length: 10 }, (_, row) => `COMMITTED ${row}`);
		let acknowledged = false;
		let hidden = 2;
		tui.setFrameProvider({
			renderFrame: size => ({
				history: acknowledged ? undefined : { id: 1, rows: history },
				viewport: renderForScrollback(() => image.render(size.columns)).slice(hidden),
			}),
			acknowledgeHistory() {
				acknowledged = true;
			},
		});
		try {
			tui.start();
			await settle(term);
			for (const nextHidden of [2, 3, 2]) {
				hidden = nextHidden;
				tui.requestRender(true);
				await settle(term);
				expect(
					term
						.getViewport()
						.slice(0, 10)
						.map(line => line.trimEnd()),
				).toEqual(history);
				expect(term.getViewport().flatMap((line, row) => (line.includes(RASTER) ? [row] : []))).toEqual(
					Array.from({ length: 4 - hidden }, (_, index) => 10 + index),
				);
				expect(raster.scrolls).toBe(0);
				expect(raster.pixelRows[0]).toBe(10 * CELL.heightPx);
			}
			expect(raster.stale).toBe(0);
			expect(term.getBufferPosition().baseY).toBe(0);
		} finally {
			tui.stop();
		}
	});

	for (const fullscreen of [false, true]) {
		it(`clears obsolete raster rows after a budget demotion on the ${fullscreen ? "alternate" : "normal"} screen`, async () => {
			deterministicSixel();
			const term = new VirtualTerminal(40, 12);
			trackSixelRaster(term);
			const tui = new TUI(term);
			const older = graphic(tui, "older");
			const newer = graphic(tui, "newer");
			const render = (width: number) => [...older.render(width), ...newer.render(width)];
			tui.setFrameProvider({ renderFrame: size => ({ viewport: render(size.columns) }), acknowledgeHistory() {} });
			if (fullscreen) tui.showOverlay({ render, invalidate() {} }, { fullscreen: true, anchor: "top-left" });
			try {
				tui.start();
				await settle(term);
				expect(term.getViewport().filter(line => line.includes(RASTER))).toHaveLength(8);
				tui.imageBudget.setCap(1);
				tui.requestRender();
				await settle(term);
				expect(term.getViewport().flatMap((line, row) => (line.includes(RASTER) ? [row] : []))).toEqual([
					4, 5, 6, 7,
				]);
				expect(term.getViewport()[3]).toContain("Image");
			} finally {
				tui.stop();
			}
		});
	}

	for (const clippedRows of [1, 2, 3]) {
		it(`keeps a real Image within its ${4 - clippedRows} visible rows after top clipping`, async () => {
			const encodeSixel = spyOn(natives, "encodeSixelAsync");
			const term = new VirtualTerminal(40, 8);
			const raster = trackSixelRaster(term);
			const tui = new TUI(term);
			const graphic = new Image(
				BASE64_ONE_PIXEL_PNG,
				"image/png",
				{ fallbackColor: text => text },
				{ maxWidthCells: 4, maxHeightCells: 4, budget: tui.imageBudget, imageKey: `clipped-${clippedRows}` },
				{ widthPx: 40, heightPx: 80 },
			);
			let clip = false;
			let repaint = false;
			tui.setFrameProvider({
				renderFrame: size => ({
					viewport: [
						...graphic
							.render(size.columns)
							.slice(clip ? clippedRows : 0)
							.map((line, index, lines) => (repaint && index === lines.length - 1 ? `${line}\x1b[0m` : line)),
						"following text",
						"another untouched line",
					],
				}),
				acknowledgeHistory() {},
			});
			try {
				tui.start();
				await settle(term);
				await encodeSixel.mock.results[0]?.value;
				await settle(term);
				expect(raster.paints).toBeGreaterThan(0);
				expect(term.getViewport()[4]?.trimEnd()).toBe("following text");

				clip = true;
				tui.requestRender();
				await settle(term);
				const paints = raster.paints;
				expect(paints).toBeGreaterThan(1);
				// Change only a harmless suffix on the real Image line so it is
				// repainted while following text stays byte-identical and skipped.
				// An uncropped raster now overwrites that previously painted text.
				repaint = true;
				tui.requestRender();
				await settle(term);
				expect(raster.paints).toBeGreaterThan(paints);
				const viewport = term.getViewport();
				expect(viewport.flatMap((line, row) => (line.includes(RASTER) ? [row] : []))).toEqual(
					Array.from({ length: 4 - clippedRows }, (_, row) => row),
				);
				expect(viewport[4 - clippedRows]?.trimEnd()).toBe("following text");
				expect(viewport[5 - clippedRows]?.trimEnd()).toBe("another untouched line");
			} finally {
				tui.stop();
			}
		});
	}

	it("drops a top-clipped SIXEL the cropper cannot parse instead of failing the frame", async () => {
		const term = new VirtualTerminal(40, 8);
		const raster = trackSixelRaster(term);
		const tui = new TUI(term);
		// A palette definition after drawing is outside the cropper's grammar.
		const foreign = '\x1bP0;1;0q"1;1;40;80#1;2;100;0;0#1!40~#2;2;0;100;0#2!40~\x1b\\';
		const block = ["", "", "", `\x1b7\x1b[3A${foreign}\x1b8`];
		let clip = false;
		tui.setFrameProvider({
			renderFrame: () => ({ viewport: [...block.slice(clip ? 2 : 0), "following text"] }),
			acknowledgeHistory() {},
		});
		try {
			tui.start();
			await settle(term);
			const paints = raster.paints;
			expect(paints).toBeGreaterThan(0);

			clip = true;
			tui.requestRender();
			await settle(term);
			expect(raster.paints).toBe(paints);
			expect(term.getViewport()[2]?.trimEnd()).toBe("following text");
		} finally {
			tui.stop();
		}
	});
});
