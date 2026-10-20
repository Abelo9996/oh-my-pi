/**
 * Contract: a steer that lands while a kept-alive subagent is producing its
 * final `yield` belongs to that run. The run settles on the yield the worker
 * gives after seeing the steer, and the registry ref is idle when it returns.
 *
 * Regression for #16490: the terminal yield aborted the run with the steer
 * still queued; the post-abort queue drain replayed it as an unobserved turn,
 * so the follow-up returned the stale pre-steer result while the ref was still
 * `running`, and the vibe runtime tombstoned the live worker as unrecoverable.
 */
import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { runSubagentFollowUpTurn, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import * as imageLoading from "@oh-my-pi/pi-coding-agent/utils/image-loading";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const AGENT_ID = "SteerAfterYield";
const MOCK_API_SOURCE = "test/steer-after-yield";
const STEER = "Also cover the edge case.";
const AGENT: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	tools: ["read"],
	source: "bundled",
};

let root: string;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-steer-after-yield-"));
	const home = path.join(root, "home");
	await fs.mkdir(path.join(home, "work"), { recursive: true });
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	registerMockApi(MOCK_API_SOURCE);
});

afterEach(async () => {
	await AgentLifecycleManager.global().dispose();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
	__resetDirsFromEnvForTests();
	AgentStorage.close();
	closeModelCache();
	await removeWithRetries(root);
});

it("settles on the steered yield even when message preparation outlasts the earlier yield", async () => {
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const yields: string[] = [];
	let steeringStarted = false;
	const mock = createMockModel({
		handler: context => {
			if (!(context.tools ?? []).some(tool => tool.name === "yield")) return { content: ["label"] };
			const lastUser = JSON.stringify(context.messages.findLast(message => message.role === "user")?.content);
			let data = "initial";
			if (lastUser.includes(STEER)) {
				data = "steered";
			} else if (lastUser.includes("continue")) {
				data = "pre-steer";
				// The parent steers while the worker is already emitting its final yield.
				steeringStarted = true;
				void AgentRegistry.global().get(AGENT_ID)?.session?.steer(STEER, undefined, { attribution: "agent" });
			}
			yields.push(data);
			return {
				// Provider latency keeps the steered answer in flight past the pre-steer yield's run end.
				delayMs: data === "steered" ? 200 : 0,
				content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data } }],
			};
		},
	});
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [mock, ...catalogAvailable(kind)]);
	const artifactsDir = path.join(root, "artifacts");
	await fs.mkdir(artifactsDir, { recursive: true });
	try {
		const first = await runSubprocess({
			cwd: path.join(root, "home", "work"),
			artifactsDir,
			agent: AGENT,
			task: "report",
			index: 0,
			id: AGENT_ID,
			modelOverride: "mock/mock-model",
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				"task.agentIdleTtlMs": 0,
				"async.enabled": false,
				"compaction.enabled": false,
				"retry.enabled": false,
				"todo.enabled": false,
				"todo.reminders": false,
				"advisor.enabled": false,
				modelRoles: { default: "mock/mock-model" },
			}),
			enableLsp: false,
			enableMCP: false,
			enableIrc: false,
		});
		expect(first.exitCode).toBe(0);

		const preSteerYieldEnded = Promise.withResolvers<void>();
		const session = AgentRegistry.global().get(AGENT_ID)?.session;
		if (!session) throw new Error("worker session missing");
		const unsubscribe = session.subscribe(event => {
			if (event.type === "tool_execution_end" && event.toolName === "yield") {
				queueMicrotask(() => preSteerYieldEnded.resolve());
			}
		});
		const normalizeImages = imageLoading.normalizeModelContextImages;
		vi.spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async (images, options) => {
			if (steeringStarted && images === undefined) await preSteerYieldEnded.promise;
			return normalizeImages(images, options);
		});

		const result = await runSubagentFollowUpTurn({ id: AGENT_ID, agent: AGENT, message: "continue", artifactsDir });
		unsubscribe();

		const ref = AgentRegistry.global().get(AGENT_ID);
		expect({
			exitCode: result.exitCode,
			output: result.output,
			status: ref?.status,
			streaming: ref?.session?.isStreaming,
			yields,
		}).toEqual({
			exitCode: 0,
			output: '"steered"',
			status: "idle",
			streaming: false,
			yields: ["initial", "pre-steer", "steered"],
		});
	} finally {
		authStorage.close();
	}
}, 30_000);
