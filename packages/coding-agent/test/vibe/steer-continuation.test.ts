/**
 * Contract: a `vibe_send` that races the end of a worker's turn never strands
 * the worker. A continuation the worker is still streaming when its run returns
 * is waited out before the turn settles, and a message sent while the turn is
 * aborting or settling is delivered as the next turn (#16490).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ExecutorOptions, FollowUpTurnOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";

const OWNER = "vibe-parent";

function resultFor(options: { index?: number; id: string; agent: ExecutorOptions["agent"] }): SingleResult {
	return {
		index: options.index ?? 0,
		id: options.id,
		agent: options.agent.name,
		agentSource: options.agent.source,
		task: "",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
	};
}

describe("vibe turn settlement around a late steer", () => {
	let manager: AsyncJobManager;
	let parent: ToolSession;

	beforeEach(() => {
		manager = new AsyncJobManager({ onJobComplete: () => {} });
		parent = {
			cwd: "/tmp",
			settings: Settings.isolated(),
			asyncJobManager: manager,
			getAgentId: () => OWNER,
			getSessionId: () => "vibe-parent-session",
			getSessionFile: () => null,
			getArtifactsDir: () => null,
			taskDepth: 0,
			enableLsp: false,
		} as unknown as ToolSession;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await manager.dispose({ timeoutMs: 100 });
		VibeSessionRegistry.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	/** Spawns a worker whose first run returns on `release`, with `live` registered as its session. */
	async function spawnWorker(live: Partial<AgentSession>, status: "running" | "idle") {
		const release = Promise.withResolvers<void>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			await release.promise;
			return resultFor(options);
		});
		const registry = VibeSessionRegistry.global();
		const spawned = await registry.spawn(parent, { cli: "fast", prompt: "initial work" });
		AgentRegistry.global().register({
			id: spawned.id,
			displayName: spawned.id,
			kind: "sub",
			parentId: OWNER,
			session: live as AgentSession,
			status,
		});
		return { registry, spawned, release: () => release.resolve() };
	}

	it("waits out a continuation still streaming at run end and runs a message sent meanwhile as the next turn", async () => {
		const waiting = Promise.withResolvers<void>();
		const idle = Promise.withResolvers<void>();
		const steer = vi.fn(async () => {});
		const live: Partial<AgentSession> = {
			isStreaming: true,
			steer,
			waitForIdle: () => {
				waiting.resolve();
				return idle.promise;
			},
		};
		const { registry, spawned, release } = await spawnWorker(live, "running");
		const followUp = Promise.withResolvers<FollowUpTurnOptions>();
		vi.spyOn(executorModule, "runSubagentFollowUpTurn").mockImplementation(async options => {
			followUp.resolve(options);
			return resultFor(options);
		});
		release();
		const turn = manager.getJob(spawned.jobId)?.promise;
		// The run has returned; the worker's continuation finishes afterwards.
		await Promise.race([waiting.promise, turn]);
		const sent = await registry.send(parent, { session: spawned.id, message: "during settle" });
		AgentRegistry.global().setStatus(spawned.id, "idle");
		idle.resolve();
		await turn;

		expect(sent.mode).toBe("queued");
		expect((await followUp.promise).message).toBe("during settle");
		expect(steer).not.toHaveBeenCalled();
	});

	it("delivers a message sent while the turn is aborting as the next turn", async () => {
		const steer = vi.fn(async () => {});
		const live: Partial<AgentSession> = {
			isStreaming: true,
			isAborting: true,
			steer,
			waitForIdle: async () => {},
		};
		const { registry, spawned, release } = await spawnWorker(live, "idle");
		const followUp = Promise.withResolvers<FollowUpTurnOptions>();
		vi.spyOn(executorModule, "runSubagentFollowUpTurn").mockImplementation(async options => {
			followUp.resolve(options);
			return resultFor(options);
		});

		const outcome = await registry.send(parent, { session: spawned.id, message: "late constraint" });
		release();

		expect(outcome.mode).toBe("queued");
		expect((await followUp.promise).message).toBe("late constraint");
		expect(steer).not.toHaveBeenCalled();
	});
});
