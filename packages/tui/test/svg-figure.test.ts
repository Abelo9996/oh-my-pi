import * as path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as natives from "@oh-my-pi/pi-natives";
import { FigureMarkdown } from "@oh-my-pi/pi-tui/chat/figure-markdown";
import { SvgFigure } from "@oh-my-pi/pi-tui/chat/svg-figure";
import { ImageBudget } from "@oh-my-pi/pi-tui/components/image";
import { fencedCode, Markdown } from "@oh-my-pi/pi-tui/components/markdown";
import { getKittyGraphics, setKittyGraphics } from "@oh-my-pi/pi-tui/kitty-graphics";
import {
	type CellDimensions,
	getCellDimensions,
	ImageProtocol,
	setCellDimensions,
	setTerminalImageProtocol,
	TERMINAL,
} from "@oh-my-pi/pi-tui/terminal-capabilities";
import { getMarkdownTheme, initTheme } from "@oh-my-pi/pi-tui/theme";
import { Container, TUI } from "@oh-my-pi/pi-tui/tui";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

withoutTerminalMultiplexer();

/** A HiDPI cell; 838 units at 2.25 px/unit is 1885.5 px, not a whole number of cells. */
const CELL: CellDimensions = { widthPx: 16, heightPx: 36 };
const SVG = `<svg viewBox="0 0 838 200"><rect width="838" height="200" fill="var(--accent)"/></svg>`;
const LANDSCAPE_SVG = '<svg viewBox="0 0 400 300"><rect width="400" height="300" fill="#f00"/></svg>';

/** A final figure whose raster landings resolve `landed()`. */
function figure(): { figure: SvgFigure; landed: () => Promise<void> } {
	let resolve = () => {};
	const svg = new SvgFigure({ onChange: () => resolve() });
	svg.update(SVG, true);
	return {
		figure: svg,
		landed: () => {
			const next = Promise.withResolvers<void>();
			resolve = next.resolve;
			return next.promise;
		},
	};
}

/** The raster's pixels and the pixels of the cell box its Kitty placement asks the terminal to fill. */
function placement(svg: SvgFigure, width: number): { raster: string; box: string; columns: number } {
	const match = /c=(\d+),r=(\d+)/.exec(svg.render(width).join("\n"));
	if (!match) throw new Error("no Kitty placement rendered");
	const columns = Number(match[1]);
	const rows = Number(match[2]);
	return {
		raster: String(svg.debugState().raster),
		box: `${columns * CELL.widthPx}x${rows * CELL.heightPx}`,
		columns,
	};
}

describe("SvgFigure", () => {
	const originalProtocol = TERMINAL.imageProtocol;
	const originalCell = { ...getCellDimensions() };
	const originalGraphics = { ...getKittyGraphics() };

	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(() => {
		setTerminalImageProtocol(ImageProtocol.Kitty);
		setCellDimensions(CELL);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		setTerminalImageProtocol(originalProtocol);
		setCellDimensions(originalCell);
		setKittyGraphics(originalGraphics);
	});

	// Regression: a 1886 px raster was placed over 117 cells (1872 px), so the
	// terminal resampled it by 0.99 and every glyph edge blurred.
	it("draws at its natural size onto exactly the cells it is placed over", async () => {
		const { figure: svg, landed } = figure();
		const raster = landed();
		svg.render(200);
		await raster;
		const shown = placement(svg, 200);
		expect(shown.columns).toBe(118);
		expect(shown.box).toBe(shown.raster);
	});

	it("replaces an SVG raster without leaving either revision over subsequent prose", async () => {
		setKittyGraphics({ unicodePlaceholders: false });
		const term = new VirtualTerminal(100, 30);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		let landed = Promise.withResolvers<void>();
		const svg = new SvgFigure({
			budget: tui.imageBudget,
			onChange: () => {
				landed.resolve();
				tui.requestRender();
			},
		});
		svg.update(SVG, true);
		let width = 80;
		let visible = true;
		tui.setFrameProvider({
			renderFrame: () => ({ viewport: visible ? svg.render(width) : ["prose replacing the figure"] }),
			acknowledgeHistory() {},
		});
		try {
			tui.start();
			await scheduler.settle(term);
			await landed.promise;
			await scheduler.advance(term, 400);
			const first = term.graphicsPlacements();
			expect(first).toHaveLength(1);

			landed = Promise.withResolvers<void>();
			width = 40;
			tui.requestRender();
			await scheduler.settle(term);
			await landed.promise;
			await scheduler.settle(term);
			const replacement = term.graphicsPlacements();
			expect(replacement).toHaveLength(1);
			expect(replacement[0]!.imageId).not.toBe(first[0]!.imageId);
			expect(replacement[0]!.numCols).toBeLessThan(first[0]!.numCols);

			visible = false;
			svg.dispose();
			tui.requestRender();
			await scheduler.settle(term);
			expect(term.graphicsPlacements()).toEqual([]);
			expect(term.getViewport()[0]?.trimEnd()).toBe("prose replacing the figure");
		} finally {
			svg.dispose();
			tui.stop();
		}
	});

	it("redraws for a narrower width instead of leaving the terminal to shrink it", async () => {
		const { figure: svg, landed } = figure();
		let raster = landed();
		svg.render(200);
		await raster;
		raster = landed();
		svg.render(80);
		await raster;
		const shown = placement(svg, 80);
		expect(shown.columns).toBe(78);
		expect(shown.box).toBe(shown.raster);
	});

	it("reuses settled figure Markdown rows for container memoization and updates them after resizing", async () => {
		let maxRows = 4;
		let landed = Promise.withResolvers<void>();
		const block = new FigureMarkdown(fencedCode("svg", SVG), {
			markdown: text => new Markdown(text, 0, 0, getMarkdownTheme()),
			charts: false,
			maxRows: () => maxRows,
			onChange: () => landed.resolve(),
		});
		const container = new Container();
		container.addChild({ render: width => block.render(width), dispose: () => block.dispose() });
		try {
			container.render(200);
			await landed.promise;
			const first = container.render(200);
			expect(first.some(row => TERMINAL.isImageLine(row))).toBe(true);
			expect(container.render(200)).toBe(first);

			landed = Promise.withResolvers<void>();
			maxRows = 2;
			container.render(200);
			await landed.promise;
			const resized = container.render(200);
			expect(resized).not.toBe(first);
			expect(resized).toHaveLength(2);
			expect(resized.some(row => TERMINAL.isImageLine(row))).toBe(true);
			expect(container.render(200)).toBe(resized);
		} finally {
			container.dispose();
		}
	});

	it("fits an SVG fence's reserved rows and SIXEL payload within a smaller surface", async () => {
		setTerminalImageProtocol(ImageProtocol.Sixel);
		let changed = Promise.withResolvers<void>();
		const block = new FigureMarkdown(fencedCode("svg", LANDSCAPE_SVG), {
			markdown: text => new Markdown(text, 0, 0, getMarkdownTheme()),
			charts: false,
			maxRows: () => 4,
			onChange: () => changed.resolve(),
		});
		try {
			block.render(76);
			await changed.promise;
			changed = Promise.withResolvers<void>();
			const reserved = block.render(76);
			await changed.promise;
			const drawn = block.render(76);
			expect(reserved.length).toBeLessThanOrEqual(4);
			expect(drawn.length).toBeLessThanOrEqual(4);
			expect(drawn.at(-1)).toMatch(/\x1bP[\d;]*q/);
		} finally {
			block.dispose();
		}
	});

	it.each(["row callback", "setter"] as const)(
		"keeps an already drawn SVG within a smaller %s bound while its raster is replaced",
		async bound => {
			setTerminalImageProtocol(ImageProtocol.Sixel);
			const encoded = spyOn(natives, "encodeSixelAsync");
			const budget = new ImageBudget(1);
			let maxRows = 12;
			let landed = Promise.withResolvers<void>();
			const svg = new SvgFigure({
				budget,
				maxRows: bound === "row callback" ? () => maxRows : bound === "setter" ? maxRows : undefined,
				onChange: () => landed.resolve(),
			});
			svg.update(LANDSCAPE_SVG, true);
			const render = (): readonly string[] => {
				budget.beginPass();
				let rows = svg.render(76);
				if (budget.endPass()) {
					budget.beginPass();
					rows = svg.render(76);
					budget.endPass();
				}
				return rows;
			};
			try {
				render();
				await landed.promise;
				render();
				await encoded.mock.results.at(-1)?.value;
				const initial = render();
				expect(initial.length).toBeGreaterThan(4);
				expect(initial.at(-1)).toMatch(/\x1bP[\d;]*q/);

				landed = Promise.withResolvers<void>();
				maxRows = 4;
				if (bound === "setter") svg.setMaxRows(maxRows);
				const pending = render();
				expect(pending.length).toBeLessThanOrEqual(maxRows);
				expect(encoded.mock.calls.at(-1)?.[2]).toBeLessThanOrEqual(maxRows * CELL.heightPx);
				await encoded.mock.results.at(-1)?.value;
				await landed.promise;
				const replacing = render();
				expect(replacing.length).toBeLessThanOrEqual(maxRows);
				expect(replacing.at(-1)).toMatch(/\x1bP[\d;]*q/);
				await encoded.mock.results.at(-1)?.value;
				const drawn = render();
				expect(drawn.length).toBeLessThanOrEqual(maxRows);
				expect(drawn.at(-1)).toMatch(/\x1bP[\d;]*q/);
				const raster = /"\d+;\d+;(\d+);(\d+)/.exec(drawn.join("\n"));
				expect(raster).not.toBeNull();
				expect(Math.ceil(Number(raster![2]) / CELL.heightPx)).toBeLessThanOrEqual(maxRows);
			} finally {
				svg.dispose();
			}
		},
	);

	it.each(["row callback", "setter"] as const)(
		"hides placeholders and existing images at zero rows through a %s, then draws when room returns",
		async bound => {
			let maxRows = 0;
			const landed = Promise.withResolvers<void>();
			const block = new FigureMarkdown(fencedCode("svg", LANDSCAPE_SVG), {
				markdown: text => new Markdown(text, 0, 0, getMarkdownTheme()),
				charts: false,
				maxRows: bound === "row callback" ? () => maxRows : bound === "setter" ? maxRows : undefined,
				onChange: () => landed.resolve(),
			});
			const render = () => block.render(76);
			try {
				expect(render()).toEqual([]);
				await Promise.resolve();
				expect(render()).toEqual([]);
				expect(block.pending).toBe(false);

				maxRows = 4;
				if (bound === "setter") block.setMaxRows(maxRows);
				render();
				await landed.promise;
				expect(render().some(row => TERMINAL.isImageLine(row))).toBe(true);

				maxRows = 0;
				if (bound === "setter") block.setMaxRows(maxRows);
				expect(render()).toEqual([]);
				maxRows = 4;
				if (bound === "setter") block.setMaxRows(maxRows);
				expect(render().some(row => TERMINAL.isImageLine(row))).toBe(true);
			} finally {
				block.dispose();
			}
		},
	);

	it("keeps failed SVG rows stable for container memoization as ceilings and source change", async () => {
		let landed = Promise.withResolvers<void>();
		const svg = new SvgFigure({
			markdown: text => new Markdown(text, 0, 0, getMarkdownTheme()),
			onChange: () => landed.resolve(),
		});
		const container = new Container();
		container.addChild(svg);
		svg.update("not an svg\nsecond line\nthird line", true);
		try {
			container.render(76);
			await landed.promise;
			const full = container.render(76);
			expect(full.join("\n")).toContain("third line");
			expect(container.render(76)).toBe(full);
			svg.setMaxRows(full.length);
			expect(container.render(76)).toBe(full);

			svg.setMaxRows(2);
			const clipped = container.render(76);
			expect(clipped).toHaveLength(2);
			expect(clipped.join("\n")).toContain("not an svg");
			expect(container.render(76)).toBe(clipped);
			svg.setMaxRows(0);
			expect(container.render(76)).toEqual([]);
			svg.setMaxRows(3);
			const expanded = container.render(76);
			expect(expanded).toHaveLength(3);
			expect(expanded.join("\n")).toContain("second line");
			expect(container.render(76)).toBe(expanded);

			landed = Promise.withResolvers<void>();
			svg.update("replacement invalid svg\nsecond replacement\nthird replacement", true);
			container.render(76);
			await landed.promise;
			const replacement = container.render(76);
			expect(replacement).toHaveLength(3);
			expect(replacement.join("\n")).toContain("replacement invalid svg");
			expect(container.render(76)).toBe(replacement);
			svg.setMaxRows(undefined);
			const restored = container.render(76);
			expect(restored.join("\n")).toContain("third replacement");
			expect(container.render(76)).toBe(restored);
		} finally {
			container.dispose();
		}
	});

	// Regression (#15660): with no theme installed the palette threw inside the
	// raster, so the figure was marked failed and showed its source instead.
	it("draws in a process that never installed a theme", async () => {
		const script = `
			import { SvgFigure } from "@oh-my-pi/pi-tui/chat/svg-figure";
			const landed = Promise.withResolvers();
			const svg = new SvgFigure({ onChange: () => landed.resolve() });
			svg.update(${JSON.stringify(SVG)}, true);
			await Promise.resolve();
			svg.render(80);
			await landed.promise;
			process.stdout.write(JSON.stringify(svg.debugState()));
		`;
		const proc = Bun.spawn([process.execPath, "--eval", script], {
			cwd: path.resolve(import.meta.dir, ".."),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		expect(exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout)).toMatchObject({ failed: false, current: true });
	});
});
