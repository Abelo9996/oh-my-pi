import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { CompactionCancelledError, type CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance, type Theme, theme } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { Container, Spacer } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";

/**
 * Contract under test: `CommandController.executeCompaction` must not leak
 * transient UI across either terminal state.
 *
 *  - A cancelled compaction (session.compact rejects with the real
 *    CompactionCancelledError the code branches on) must leave the chat
 *    transcript byte-for-byte as it was — no orphan Spacer pushed into
 *    chatContainer — and must drain the status container's loader.
 *  - A successful compaction must drain the status container's loader once it
 *    resolves.
 *
 * Exercised only through the public `executeCompaction` entrypoint with real
 * in-memory Container instances and a session stub whose `compact()` outcome we
 * drive.
 */
function buildCtx(compact: InteractiveModeContext["session"]["compact"]) {
	const chatContainer = new Container();
	const statusContainer = new Container();
	// Pre-existing transcript content. The regression we defend leaked an extra
	// Spacer into this container on the cancel path, so we seed it with real
	// children and require the count to survive the call untouched.
	chatContainer.addChild(new Spacer(1));
	chatContainer.addChild(new Spacer(1));

	// Record the status container's state at the instant the transcript rebuild
	// runs, so a test can prove cleanup happens BEFORE the rebuild (the fix) and
	// not merely in the finally that runs after it.
	let statusChildrenAtRebuild: number | undefined;
	const rebuildChatFromMessages = vi.fn(() => {
		statusChildrenAtRebuild = statusContainer.children.length;
	});
	const showError = vi.fn();
	const ctx = {
		loadingAnimation: undefined,
		chatContainer,
		statusContainer,
		ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
		session: { compact },
		rebuildChatFromMessages,
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		showError,
		flushCompactionQueue: vi.fn(async () => undefined),
		keybindings: KeybindingsManager.inMemory(),
		// executeCompaction consults display.collapseCompacted on the ok path to
		// decide whether the rebuild replaces the terminal transcript.
		settings: Settings.isolated({ "display.collapseCompacted": true }),
	} as unknown as InteractiveModeContext;

	return {
		ctx,
		chatContainer,
		statusContainer,
		rebuildChatFromMessages,
		showError,
		statusAtRebuild: () => statusChildrenAtRebuild,
	};
}

describe("executeCompaction UI lifecycle", () => {
	let priorTheme: Theme | undefined;

	beforeAll(async () => {
		// The compacting Loader colorizes through the active theme on construction.
		// Capture the prior global theme first so afterAll can restore it and not
		// couple later suites sharing this process to our dark override.
		priorTheme = theme;
		const dark = await getThemeByName("dark");
		if (!dark) throw new Error("Expected dark theme");
		setThemeInstance(dark);
	});

	afterAll(() => {
		if (priorTheme) setThemeInstance(priorTheme);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("leaves the transcript untouched and drains the loader when compaction is cancelled", async () => {
		const compact = vi.fn(async () => {
			throw new CompactionCancelledError();
		});
		const { ctx, chatContainer, statusContainer, rebuildChatFromMessages, showError } = buildCtx(compact);
		const childrenBefore = chatContainer.children.length;

		const controller = new CommandController(ctx);
		const outcome = await controller.executeCompaction();

		expect(outcome).toBe("cancelled");
		// No orphan Spacer leaked into the chat transcript on the cancel path.
		expect(chatContainer.children).toHaveLength(childrenBefore);
		// The compacting loader was removed from the status container.
		expect(statusContainer.children).toHaveLength(0);
		// Proof the cancel branch ran instead of the success branch.
		expect(showError).toHaveBeenCalledWith("Compaction cancelled");
		expect(rebuildChatFromMessages).not.toHaveBeenCalled();
	});

	it("drains the loader after a successful compaction resolves", async () => {
		const compact = vi.fn(async (): Promise<CompactionResult<unknown>> => ({
			summary: "",
			firstKeptEntryId: "",
			tokensBefore: 0,
		}));
		const { ctx, statusContainer, rebuildChatFromMessages, statusAtRebuild } = buildCtx(compact);

		const controller = new CommandController(ctx);
		const outcome = await controller.executeCompaction();

		expect(outcome).toBe("ok");
		// Status container is empty once compaction resolves.
		expect(statusContainer.children).toHaveLength(0);
		// Post-compaction rebuilds preserve settled components so their warmed
		// Markdown/layout caches survive the transcript reset.
		expect(rebuildChatFromMessages).toHaveBeenCalledWith({ reuseSettledComponents: true });
		// The loader was drained BEFORE the transcript rebuild, not only by the
		// finally that runs afterward: the status container was already empty at
		// the instant rebuildChatFromMessages ran (1 leaked loader without the fix).
		expect(statusAtRebuild()).toBe(0);
	});
});

describe("compaction queued for the next yield", () => {
	/** `agentRun`: the agent loop streams; `promptSetup`: a prompt is in pre-dispatch setup (no agent run
	 *  yet); `compactingChecks`: how many `isCompacting` reads report a pass started elsewhere. */
	function buildYieldCtx(onWaitForIdle: (state: { agentRun: boolean; promptSetup: boolean }) => void = () => {}) {
		const state = { agentRun: false, promptSetup: false, compactingChecks: 0 };
		const session = {
			agent: {
				state: {
					get isStreaming() {
						return state.agentRun;
					},
				},
			},
			get isStreaming() {
				return state.agentRun || state.promptSetup;
			},
			get isCompacting() {
				if (state.compactingChecks === 0) return false;
				state.compactingChecks--;
				return true;
			},
			waitForIdle: vi.fn(async () => onWaitForIdle(state)),
			waitForAdmittedSubmissions: vi.fn(async () => {}),
		};
		const compactingAtFlush: boolean[] = [];
		const flushCompactionQueue = vi.fn(async () => {
			compactingAtFlush.push(state.compactingChecks > 0);
		});
		const ctx = {
			session,
			yieldCompaction: { text: "/compact soft", mode: "soft" },
			updatePendingMessagesDisplay: vi.fn(),
			showStatus: vi.fn(),
			showWarning: vi.fn(),
			flushCompactionQueue,
			sessionManager: { getEntries: () => [{ type: "message" }] },
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);
		const handleCompactCommand = vi.spyOn(controller, "handleCompactCommand");
		return { state, ctx, controller, handleCompactCommand, flushCompactionQueue, compactingAtFlush };
	}

	it("runs the queued compaction once the session is idle", async () => {
		const { ctx, controller, handleCompactCommand } = buildYieldCtx();
		handleCompactCommand.mockResolvedValue("ok");

		await controller.runYieldCompaction();

		expect(handleCompactCommand).toHaveBeenCalledWith(undefined, "soft");
		expect(ctx.yieldCompaction).toBeUndefined();
	});

	it("keeps the request for the next settle when a new run started first", async () => {
		const { ctx, controller, handleCompactCommand } = buildYieldCtx(state => {
			state.agentRun = true;
		});

		await controller.runYieldCompaction();

		expect(handleCompactCommand).not.toHaveBeenCalled();
		expect(ctx.yieldCompaction).toEqual({ text: "/compact soft", mode: "soft" });
	});

	it("runs once a prompt still in setup bails without starting a run", async () => {
		let idleWaits = 0;
		const { state, controller, handleCompactCommand } = buildYieldCtx(current => {
			// The prompt bails before the second idle check.
			if (++idleWaits === 2) current.promptSetup = false;
		});
		handleCompactCommand.mockResolvedValue("ok");
		state.promptSetup = true;

		await controller.runYieldCompaction();

		expect(handleCompactCommand).toHaveBeenCalledWith(undefined, "soft");
	});

	it("releases held follow-ups when there is nothing to compact", async () => {
		const { ctx, controller, flushCompactionQueue } = buildYieldCtx();

		await controller.runYieldCompaction();

		expect(ctx.showWarning).toHaveBeenCalledWith("Nothing to compact (no messages yet)");
		expect(flushCompactionQueue).toHaveBeenCalled();
	});

	it("releases held follow-ups after a compaction started elsewhere ends", async () => {
		const { state, controller, handleCompactCommand, compactingAtFlush } = buildYieldCtx();
		state.compactingChecks = 3;

		await controller.runYieldCompaction();

		expect(handleCompactCommand).not.toHaveBeenCalled();
		expect(compactingAtFlush).toEqual([false]);
	});
});
