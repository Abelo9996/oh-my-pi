import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as zlib from "node:zlib";
import { TUI } from "@oh-my-pi/pi-tui";
import { encodeRgbPng } from "@oh-my-pi/pi-tui/apps/debug/protocol-probe";
import { Image, renderForScrollback } from "@oh-my-pi/pi-tui/components/image";
import { cropPngTop, PNG_SIGNATURE, pngChunk } from "@oh-my-pi/pi-tui/render/png";
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

const CELL: CellDimensions = { widthPx: 10, heightPx: 20 };
const ITERM2_PLACEMENT = /\x1b7(?:\x1b\[(\d+)A)?\x1b\]1337;File=[^:\x07]*:([A-Za-z0-9+/=]+)\x07\x1b8/g;

/** RGB pixels that differ on every row and column, so a shifted or blended crop cannot match. */
function gradient(width: number, height: number): Uint8Array {
	const rgb = new Uint8Array(width * height * 3);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			rgb.set([(x * 37 + y * 11) & 255, (y * 29) & 255, (x * y * 7) & 255], (y * width + x) * 3);
		}
	}
	return rgb;
}

/** A canonical re-encode: equal pixels give equal bytes whatever filters or color type the input used. */
async function pixels(png: Uint8Array): Promise<Uint8Array> {
	return new Bun.Image(png).png().bytes();
}

/** The expected crop: the source pixels from row `top` down, encoded independently. */
function bottomRows(width: number, height: number, rgb: Uint8Array, top: number): Uint8Array {
	return encodeRgbPng(width, height - top, rgb.subarray(top * width * 3));
}

describe("cropPngTop", () => {
	it("keeps exact pixels below the cut when scanlines use Sub, Up and Paeth filters", async () => {
		const rgb = gradient(40, 80);
		// Bun's encoder writes RGBA with adaptive filters, unlike encodeRgbPng's None rows.
		const source = await pixels(encodeRgbPng(40, 80, rgb));
		for (const top of [1, 7, 40, 79]) {
			const cropped = cropPngTop(source, top);
			expect(cropped).not.toBeNull();
			expect(await pixels(cropped!)).toEqual(await pixels(bottomRows(40, 80, rgb, top)));
		}
	});

	it("keeps the palette of an indexed image", async () => {
		const colors = [
			[255, 0, 0],
			[0, 255, 0],
			[0, 0, 255],
			[255, 255, 0],
		];
		const ihdr = Buffer.alloc(13);
		ihdr.writeUInt32BE(4, 0);
		ihdr.writeUInt32BE(4, 4);
		ihdr[8] = 8;
		ihdr[9] = 3;
		const indices = [0, 1, 2, 3, 1, 2, 3, 0, 2, 3, 0, 1, 3, 0, 1, 2];
		const scanlines = new Uint8Array(4 * 5);
		for (let y = 0; y < 4; y++) scanlines.set(indices.slice(y * 4, y * 4 + 4), y * 5 + 1);
		const indexed = Buffer.concat([
			PNG_SIGNATURE,
			pngChunk("IHDR", ihdr),
			pngChunk("PLTE", Uint8Array.from(colors.flat())),
			pngChunk("IDAT", zlib.deflateSync(scanlines)),
			pngChunk("IEND", new Uint8Array(0)),
		]);
		const rgb = Uint8Array.from(indices.flatMap(index => colors[index]!));

		expect(await pixels(cropPngTop(indexed, 1)!)).toEqual(await pixels(bottomRows(4, 4, rgb, 1)));
	});

	it("rejects input it cannot crop exactly", async () => {
		const png = await pixels(encodeRgbPng(4, 4, gradient(4, 4)));
		expect(cropPngTop(png, 4)).toBeNull();
		expect(cropPngTop(png, -1)).toBeNull();
		expect(cropPngTop(Buffer.from("not a png"), 1)).toBeNull();
		const interlaced = Buffer.from(png);
		interlaced[8 + 8 + 12] = 1;
		expect(cropPngTop(interlaced, 1)).toBeNull();
	});
});

describe("iTerm2 live placement", () => {
	let originalCellDims: CellDimensions;
	const originalProtocol = TERMINAL.imageProtocol;

	beforeEach(() => {
		originalCellDims = { ...getCellDimensions() };
		setCellDimensions(CELL);
		setTerminalImageProtocol(ImageProtocol.Iterm2);
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

	async function settle(term: VirtualTerminal): Promise<void> {
		for (let i = 0; i < 2; i++) {
			const turn = Promise.withResolvers<void>();
			setImmediate(turn.resolve);
			await turn.promise;
			vi.advanceTimersByTime(40);
			await term.flush();
		}
	}

	it("paints only the visible rows of a chart whose top went into committed history", async () => {
		const rgb = gradient(40, 80);
		const png = await pixels(encodeRgbPng(40, 80, rgb));
		const term = new VirtualTerminal(40, 13);
		const writes: string[] = [];
		const write = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation((data: string) => {
			writes.push(data);
			write(data);
		});
		const tui = new TUI(term);
		const image = new Image(
			png.toBase64(),
			"image/png",
			{ fallbackColor: text => text },
			{ maxWidthCells: 4, maxHeightCells: 4, budget: tui.imageBudget, imageKey: "chart" },
			{ widthPx: 40, heightPx: 80 },
		);
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
			for (const nextHidden of [2, 3, 1]) {
				hidden = nextHidden;
				writes.length = 0;
				tui.requestRender(true);
				await settle(term);
				const placements = [...writes.join("").matchAll(ITERM2_PLACEMENT)];
				expect(placements).toHaveLength(1);
				const [, lift, data] = placements[0]!;
				// Anchored at the first visible row, never above the live region.
				expect(Number(lift ?? 0)).toBe(3 - hidden);
				expect(await pixels(Buffer.from(data!, "base64"))).toEqual(
					await pixels(bottomRows(40, 80, rgb, hidden * CELL.heightPx)),
				);
				expect(
					term
						.getViewport()
						.slice(0, 10)
						.map(line => line.trimEnd()),
				).toEqual(history);
			}
		} finally {
			tui.stop();
		}
	});
});
