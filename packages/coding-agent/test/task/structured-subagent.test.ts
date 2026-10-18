import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { normalizeModelPatternList, resolveModelOverride } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import {
	disableProvider,
	enableProvider,
	getDisabledProviders,
	isProviderEnabled,
	setDisabledProviders,
} from "@oh-my-pi/pi-coding-agent/capability";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { getBundledAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentCompactionThresholdOverride } from "@oh-my-pi/pi-coding-agent/config/compaction-threshold";
import type { BeforeSubagentSpawnEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import {
	artifactsDirsFromRegistry,
	resetRegisteredArtifactDirsForTests,
} from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import * as planHandoff from "@oh-my-pi/pi-coding-agent/plan-mode/plan-handoff";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";

import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { createEvalCustomTools } from "@oh-my-pi/pi-coding-agent/task/eval-tools";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import * as isolationRunner from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import {
	buildStructuredSubagentRecoveryHint,
	invalidModelSelectorReason,
	resolveEffectiveSubagentPolicy,
	runStructuredSubagent,
	StructuredSubagentError,
	type StructuredSubagentRequest,
} from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import {
	assertPerCallModelApproved,
	isPerCallModelApproved,
	PerCallModelError,
} from "@oh-my-pi/pi-coding-agent/task/model-approval";
import type { SingleResult, TaskParams } from "@oh-my-pi/pi-tui/tools/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

import { cfgRetryModelFallback } from "@oh-my-pi/pi-coding-agent/session/settings";
import { cfgTaskAgentModelOverrides, cfgTaskEnableEffort } from "@oh-my-pi/pi-coding-agent/task/settings";

const AGENT: AgentDefinition = {
	name: "worker",
	description: "Test worker",
	systemPrompt: "Do the assigned work.",
	source: "bundled",
	tools: ["read", "write", "ast_grep"],
	output: { type: "object", properties: { agent: { type: "boolean" } } },
};

/** One catalog entry so a populated registry can reject an unmatchable selector. */
const MODEL = buildModel({
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	reasoning: false,
	baseUrl: "https://api.anthropic.com",
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200000,
	maxTokens: 8192,
});

function session(
	options: {
		cwd?: string;
		settings?: Settings;
		planMode?: boolean;
		parentSpawns?: string;
		outputSchema?: unknown;
		maxDepth?: number;
		isolationEnabled?: boolean;
		isolationApply?: boolean;
		modelRoles?: Record<string, string>;
		agentServiceTierOverrides?: Record<string, string>;
		agentCompactionThresholdOverrides?: Record<string, AgentCompactionThresholdOverride>;
		sessionAgents?: readonly AgentDefinition[];
	} = {},
): ToolSession {
	return {
		cwd: options.cwd ?? "/tmp",
		hasUI: false,
		outputSchema: options.outputSchema,
		settings:
			options.settings ??
			Settings.isolated({
				"task.maxRecursionDepth": options.maxDepth ?? 2,
				"task.perCallModel": "on",
				"task.isolation.enabled": options.isolationEnabled ?? false,
				"isolation.backend": "rcopy",
				"task.enableLsp": true,
				...(options.modelRoles ? { modelRoles: options.modelRoles } : {}),
				...(options.isolationApply !== undefined ? { "task.isolation.apply": options.isolationApply } : {}),
				...(options.agentServiceTierOverrides
					? { "task.agentServiceTierOverrides": options.agentServiceTierOverrides }
					: {}),
				...(options.agentCompactionThresholdOverrides
					? { "task.agentCompactionThresholdOverrides": options.agentCompactionThresholdOverrides }
					: {}),
			}),
		getSessionFile: () => null,
		getSessionSpawns: () => options.parentSpawns ?? "*",
		getSessionAgents: () => options.sessionAgents ?? [],
		getPlanModeState: () => (options.planMode ? { enabled: true } : undefined),
	} as unknown as ToolSession;
}

function request(overrides: Partial<StructuredSubagentRequest> = {}): StructuredSubagentRequest {
	return {
		session: session(),
		invocationKind: "task",
		assignment: "Inspect the target.",
		agent: "worker",
		...overrides,
	};
}

function result(): SingleResult {
	return {
		index: 0,
		id: "Worker",
		agent: "worker",
		agentSource: "bundled",
		task: "Inspect the target.",
		exitCode: 0,
		output: '{"ok":true}',
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
	};
}

function mockDiscovery(agent: AgentDefinition = AGENT): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
}

afterEach(() => {
	vi.restoreAllMocks();
	resetRegisteredArtifactDirsForTests();
});

describe("structured subagent primitive", () => {
	it("resolves user-tagged model agents for task and eval but rejects untagged names", async () => {
		mockDiscovery();
		const taggedSession = session();
		taggedSession.getSessionAgents = () => [{ ...AGENT, name: "m1", model: ["a/x"] }];
		for (const invocationKind of ["task", "eval"] satisfies StructuredSubagentRequest["invocationKind"][]) {
			const policy = await resolveEffectiveSubagentPolicy(
				request({ session: taggedSession, agent: "m1", invocationKind }),
			);
			expect(policy.agent.name).toBe("m1");
			expect(policy.modelOverride).toEqual(["a/x"]);
		}
		await expect(resolveEffectiveSubagentPolicy(request({ session: taggedSession, agent: "m9" }))).rejects.toThrow(
			'Unknown agent "m9". Available: worker, m1',
		);
	});

	it("keeps discovered agents authoritative on pseudonym collisions", async () => {
		mockDiscovery({ ...AGENT, name: "m1", model: ["b/y"] });
		const taggedSession = session();
		taggedSession.getSessionAgents = () => [{ ...AGENT, name: "m1", model: ["a/x"] }];
		const policy = await resolveEffectiveSubagentPolicy(request({ session: taggedSession, agent: "m1" }));
		expect(policy.modelOverride).toEqual(["b/y"]);
	});

	it("rescans agents when a plugin provider is disabled while an earlier discovery is in flight", async () => {
		const previouslyDisabled = getDisabledProviders();
		enableProvider("omp-plugins");
		const firstEntered = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		let scans = 0;
		vi.spyOn(discoveryModule, "discoverAgents").mockImplementation(async () => {
			const pluginsEnabled = isProviderEnabled("omp-plugins");
			if (++scans === 1) {
				firstEntered.resolve();
				await releaseFirst.promise;
			}
			const agents = pluginsEnabled ? [AGENT, { ...AGENT, name: "plugin-worker" }] : [AGENT];
			return { agents, projectAgentsDir: null };
		});
		try {
			const first = resolveEffectiveSubagentPolicy(request({ agent: "plugin-worker" }));
			await firstEntered.promise;
			disableProvider("omp-plugins");
			const second = resolveEffectiveSubagentPolicy(request({ agent: "plugin-worker" }));
			releaseFirst.resolve();

			expect((await first).agent.name).toBe("plugin-worker");
			await expect(second).rejects.toThrow('Unknown agent "plugin-worker"');
		} finally {
			setDisabledProviders(previouslyDisabled);
		}
	});

	it("uses caller, agent, then session schemas in precedence order", async () => {
		mockDiscovery();
		const callerSchema = { type: "object", properties: { caller: { type: "string" } } };
		const caller = await resolveEffectiveSubagentPolicy(
			request({ outputSchema: callerSchema, schemaMode: "strict" }),
		);
		expect(caller.schema).toEqual({
			schema: callerSchema,
			source: "caller",
			mode: "strict",
			outputSchemaOverridesAgent: true,
		});

		const agent = await resolveEffectiveSubagentPolicy(
			request({ session: session({ outputSchema: { session: true } }) }),
		);
		expect(agent.schema.source).toBe("agent");
		expect(agent.schema.schema).toBe(AGENT.output);

		const noAgentOutput = { ...AGENT, output: undefined };
		mockDiscovery(noAgentOutput);
		const inheritedSession = session({ outputSchema: { session: true } });
		inheritedSession.outputSchemaMode = "strict";
		const inherited = await resolveEffectiveSubagentPolicy(request({ session: inheritedSession }));
		expect(inherited.schema).toMatchObject({ source: "session", mode: "strict", outputSchemaOverridesAgent: false });
	});

	it("requires independent approval for saved seance models while preserving trusted host choices", async () => {
		const seanceAgent = getBundledAgent("seance");
		if (!seanceAgent) throw new Error("Expected the bundled seance agent");
		mockDiscovery(seanceAgent);
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-seance-policy-"));
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const cwd = path.join(tempDir, "project");
		const sourceFile = path.join(tempDir, "sessions", "source.jsonl");
		await fs.mkdir(path.dirname(sourceFile), { recursive: true });
		await Bun.write(
			sourceFile,
			`${[
				{ type: "session", version: 3, id: "saved-source", timestamp: "2026-10-01T00:00:00.000Z", cwd },
				{
					type: "model_change",
					id: "default-model",
					parentId: null,
					timestamp: "2026-10-01T00:00:01.000Z",
					model: "anthropic/claude-sonnet-4-5",
					role: "default",
				},
				{
					type: "model_change",
					id: "active-model",
					parentId: "default-model",
					timestamp: "2026-10-01T00:00:02.000Z",
					model: "anthropic/claude-sonnet-4-6",
					role: "fast",
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const caller = Object.assign(
			session({
				cwd,
				modelRoles: { review: "anthropic/claude-sonnet-4-6", default: "anthropic/claude-sonnet-4-5" },
			}),
			{ modelRegistry },
		);
		try {
			const saved = await resolveEffectiveSubagentPolicy(
				request({ session: caller, agent: "seance", sourceSession: sourceFile }),
			);
			expect(saved.preparedSession?.fork.sourceFile).toBe(sourceFile);

			expect(saved.modelOverride).toEqual(["anthropic/claude-sonnet-4-6", "anthropic/claude-sonnet-4-5"]);
			expect(saved.enableLsp).toBe(false);
			expect(saved.enableIrc).toBe(false);

			expect(saved.perCallModelGrants).toBeDefined();
			const unconfigured = Object.assign(session({ cwd }), { modelRegistry });
			await expect(
				resolveEffectiveSubagentPolicy(
					request({ session: unconfigured, agent: "seance", sourceSession: sourceFile }),
				),
			).rejects.toThrow(/not configured|approved/);
			const parentApproved = Object.assign(session({ cwd }), {
				modelRegistry,
				getActiveModelString: () => "anthropic/claude-sonnet-4-6",
			});
			const exact = await resolveEffectiveSubagentPolicy(
				request({
					session: parentApproved,
					agent: "seance",
					sourceSession: sourceFile,
					model: "anthropic/claude-sonnet-4-6",
				}),
			);
			expect(exact.modelOverride).toEqual(["anthropic/claude-sonnet-4-6"]);
			expect(exact.parentActiveModelPattern).toBeUndefined();
			for (const hostModel of [
				"anthropic/claude-sonnet-4-5",
				["anthropic/claude-sonnet-4-6", "anthropic/claude-sonnet-4-5"],
			]) {
				const hostSession = Object.assign(
					session({ cwd, settings: Settings.isolated({ "task.perCallModel": "off" }) }),
					{ modelRegistry },
				);
				const hosted = await resolveEffectiveSubagentPolicy(
					request({ session: hostSession, agent: "seance", sourceSession: sourceFile, hostModel }),
				);
				expect(hosted.modelOverride).toEqual(typeof hostModel === "string" ? [hostModel] : hostModel);
				expect(hosted.perCallModelGrants).toBeUndefined();
			}
		} finally {
			authStorage.close();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("fails closed when the source has no saved model or an explicit model is unavailable", async () => {
		const seanceAgent = getBundledAgent("seance");
		if (!seanceAgent) throw new Error("Expected the bundled seance agent");
		mockDiscovery(seanceAgent);
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-seance-model-fail-"));
		const authStorage = await AuthStorage.create(":memory:");
		const modelRegistry = new ModelRegistry(authStorage);
		const cwd = path.join(tempDir, "project");
		const sourceFile = path.join(tempDir, "sessions", "no-model.jsonl");
		await fs.mkdir(path.dirname(sourceFile), { recursive: true });
		await Bun.write(
			sourceFile,
			`${JSON.stringify({ type: "session", version: 3, id: "no-model-source", timestamp: "2026-10-01T00:00:00.000Z", cwd })}\n`,
		);
		const caller = Object.assign(session({ cwd }), { modelRegistry });
		try {
			await expect(
				resolveEffectiveSubagentPolicy(request({ session: caller, agent: "seance", sourceSession: sourceFile })),
			).rejects.toThrow("The source session has no saved model.");
			await expect(
				resolveEffectiveSubagentPolicy(
					request({
						session: caller,
						agent: "seance",
						sourceSession: sourceFile,
						model: "missing-provider/missing-model",
					}),
				),
			).rejects.toThrow("No available saved model can serve this source.");
		} finally {
			authStorage.close();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("gives task and eval invocations identical blocked-agent preflight errors", async () => {
		const previous = Bun.env.PI_BLOCKED_AGENT;
		Bun.env.PI_BLOCKED_AGENT = "worker";
		try {
			const discover = vi.spyOn(discoveryModule, "discoverAgents");
			const taskRequest = request();
			const evalRequest = request({ session: taskRequest.session, invocationKind: "eval" });
			const messages: string[] = [];
			for (const candidate of [taskRequest, evalRequest]) {
				try {
					await resolveEffectiveSubagentPolicy(candidate);
				} catch (error) {
					expect(error).toBeInstanceOf(StructuredSubagentError);
					messages.push((error as Error).message);
				}
			}
			expect(messages).toEqual([
				"Cannot spawn worker agent from within itself (recursion prevention). Use a different agent type.",
				"Cannot spawn worker agent from within itself (recursion prevention). Use a different agent type.",
			]);
			expect(discover).not.toHaveBeenCalled();
		} finally {
			if (previous === undefined) delete Bun.env.PI_BLOCKED_AGENT;
			else Bun.env.PI_BLOCKED_AGENT = previous;
		}
	});

	it("attenuates plan-mode agents and rejects mutable isolation controls before discovery", async () => {
		mockDiscovery();
		const policy = await resolveEffectiveSubagentPolicy(
			request({ session: session({ planMode: true }), enableLsp: true, enableIrc: true }),
		);
		expect(policy.effectiveAgent.tools).toEqual(["read", "grep", "glob", "web_search", "ast_grep"]);
		expect(policy.effectiveAgent.spawns).toBeUndefined();
		expect(policy.enableLsp).toBe(false);
		expect(policy.enableIrc).toBe(false);

		vi.restoreAllMocks();
		const discover = vi.spyOn(discoveryModule, "discoverAgents");
		await expect(
			resolveEffectiveSubagentPolicy(
				request({ session: session({ planMode: true }), isolation: { requested: false } }),
			),
		).rejects.toThrow("isolation, apply, and merge controls are unavailable in plan mode");

		const planSession = session({ planMode: true });
		const customTools = createEvalCustomTools(planSession, [
			{
				name: "word_count",
				description: "Count words",
				parameters: { type: "object", properties: {} },
				language: "python",
			},
		]);
		await expect(resolveEffectiveSubagentPolicy(request({ session: planSession, customTools }))).rejects.toThrow(
			"Eval-defined tools are unavailable in plan mode.",
		);
		expect(discover).not.toHaveBeenCalled();
	});
	it("reloads project task and retry policy before resolving an agent added during the session", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-task-hot-reload-"));
		const projectDir = path.join(root, "project");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(projectDir, { recursive: true });
		await Bun.write(
			path.join(agentDir, "config.yml"),
			"task:\n  enableEffort: true\nretry:\n  modelFallback: true\n",
		);
		const liveSettings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
		const liveSession = {
			...session(),
			cwd: projectDir,
			settings: liveSettings,
		} as ToolSession;

		try {
			await Bun.write(
				path.join(projectDir, ".omp", "config.yml"),
				"task:\n  agentModelOverrides:\n    hot-worker: xai-oauth/grok-4.6:medium\n  enableEffort: false\nretry:\n  modelFallback: false\n",
			);
			await Bun.write(
				path.join(projectDir, ".omp", "agents", "hot-worker.md"),
				"---\nname: hot-worker\ndescription: Newly added worker.\nmodel: openai/gpt-4o\n---\n\nInspect the assignment.\n",
			);

			const policy = await resolveEffectiveSubagentPolicy(request({ session: liveSession, agent: "hot-worker" }));

			expect(policy.modelOverride).toEqual(["xai-oauth/grok-4.6:medium"]);
			expect(cfgTaskEnableEffort.get(liveSettings)).toBe(false);
			expect(cfgRetryModelFallback.get(liveSettings)).toBe(false);
		} finally {
			liveSettings.cancelPendingSaves();
			// `Settings.loadIsolated` opened `<agentDir>/agent.db`; Windows cannot delete it while open.
			AgentStorage.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("resolves only the exact case-sensitive service-tier override into the policy", async () => {
		mockDiscovery({ ...AGENT, name: "scout" });

		const exact = await resolveEffectiveSubagentPolicy(
			request({ session: session({ agentServiceTierOverrides: { scout: "priority" } }), agent: "scout" }),
		);
		expect(exact.serviceTierOverride).toBe("priority");

		const differentCase = await resolveEffectiveSubagentPolicy(
			request({ session: session({ agentServiceTierOverrides: { Scout: "priority" } }), agent: "scout" }),
		);
		expect(differentCase.serviceTierOverride).toBeUndefined();
	});

	it("resolves only the exact case-sensitive compaction threshold override into the policy", async () => {
		mockDiscovery({ ...AGENT, name: "scout" });
		const resolve = (overrides: Record<string, AgentCompactionThresholdOverride>) =>
			resolveEffectiveSubagentPolicy(
				request({ session: session({ agentCompactionThresholdOverrides: overrides }), agent: "scout" }),
			);

		expect((await resolve({ scout: "80%", task: 90000 })).compactionThresholdOverride).toEqual({
			thresholdPercent: 80,
			thresholdTokens: -1,
		});
		expect((await resolve({ Scout: "80%" })).compactionThresholdOverride).toBeUndefined();
		expect((await resolve({ task: 90000 })).compactionThresholdOverride).toBeUndefined();
	});

	it("reloads persisted per-agent service-tier overrides before each launch", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-task-tier-reload-"));
		const projectDir = path.join(root, "project");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(path.join(projectDir, ".omp"), { recursive: true });
		await fs.mkdir(agentDir, { recursive: true });
		const liveSettings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
		const liveSession = session({ cwd: projectDir, settings: liveSettings });
		mockDiscovery({ ...AGENT, name: "scout" });
		const configPath = path.join(agentDir, "config.yml");

		try {
			await Bun.write(configPath, "task:\n  agentServiceTierOverrides:\n    scout: priority\n");
			const first = await resolveEffectiveSubagentPolicy(request({ session: liveSession, agent: "scout" }));
			expect(first.serviceTierOverride).toBe("priority");

			await Bun.write(configPath, "task:\n  agentServiceTierOverrides:\n    scout: none\n");
			const second = await resolveEffectiveSubagentPolicy(request({ session: liveSession, agent: "scout" }));
			expect(second.serviceTierOverride).toBe("none");
		} finally {
			liveSettings.cancelPendingSaves();
			AgentStorage.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("forwards parent-authorized model agents to nested subagent sessions", async () => {
		mockDiscovery();
		const inheritedAgent: AgentDefinition = { ...AGENT, name: "m1", model: ["b/y"] };
		const parentSession = session({ sessionAgents: [inheritedAgent] });
		const dispatched: executorModule.ExecutorOptions[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			dispatched.push(options);
			return result();
		});

		const settled = await runStructuredSubagent(request({ session: parentSession, retainArtifacts: true }));

		expect(dispatched[0]?.inheritedSessionAgents).toEqual([inheritedAgent]);
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});
	it("propagates a custom thinking-suffixed role alias through policy, dispatch, and settlement", async () => {
		const customAgent = { ...AGENT, model: ["@reviewer:high"] };
		mockDiscovery(customAgent);
		const childSession = session({ modelRoles: { reviewer: "openai/gpt-4o" } });
		const dispatched: executorModule.ExecutorOptions[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			dispatched.push(options);
			return { ...result(), modelRole: options.modelRole };
		});

		const settled = await runStructuredSubagent(
			request({ session: childSession, agent: "worker", retainArtifacts: true }),
		);

		expect(settled.policy.modelRole).toBe("reviewer");
		expect(dispatched[0]?.modelRole).toBe("reviewer");
		expect(settled.result.modelRole).toBe("reviewer");
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});
	it("does not treat a spawn handle as the HUD description", async () => {
		mockDiscovery();
		const dispatched: executorModule.ExecutorOptions[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			dispatched.push(options);
			return result();
		});

		const handleOnly = await runStructuredSubagent(
			request({ identity: { id: "AuthLoader", label: "AuthLoader" }, retainArtifacts: true }),
		);
		expect(dispatched[0]?.description).toBeUndefined();
		expect(dispatched[0]?.id).toBe("AuthLoader");
		await fs.rm(handleOnly.artifactsDir, { recursive: true, force: true });

		dispatched.length = 0;
		const evalLabeled = await runStructuredSubagent(
			request({
				invocationKind: "eval",
				identity: { label: "Refactor the auth flow" },
				retainArtifacts: true,
			}),
		);
		expect(dispatched[0]?.description).toBe("Refactor the auth flow");
		await fs.rm(evalLabeled.artifactsDir, { recursive: true, force: true });
	});

	it("derives modelRole from the raw selector source in request, override, definition order", async () => {
		const customAgent = { ...AGENT, model: ["@definition"] };
		mockDiscovery(customAgent);
		const roleSession = session({
			modelRoles: {
				request: "openai/gpt-4o",
				override: "openai/gpt-4o",
				definition: "openai/gpt-4o",
			},
		});
		cfgTaskAgentModelOverrides.override(roleSession.settings, { worker: "@override" });

		const requestPolicy = await resolveEffectiveSubagentPolicy(
			request({ session: roleSession, hostModel: "@request" }),
		);
		expect(requestPolicy.modelRole).toBe("request");

		const overridePolicy = await resolveEffectiveSubagentPolicy(request({ session: roleSession }));
		expect(overridePolicy.modelRole).toBe("override");

		const concreteOverrideSession = session({
			modelRoles: {
				override: "openai/gpt-4o",
				definition: "openai/gpt-4o",
			},
		});
		cfgTaskAgentModelOverrides.override(concreteOverrideSession.settings, { worker: "openai/gpt-4o" });
		const concreteOverridePolicy = await resolveEffectiveSubagentPolicy(
			request({ session: concreteOverrideSession }),
		);
		expect(concreteOverridePolicy.modelRole).toBeUndefined();

		const definitionPolicy = await resolveEffectiveSubagentPolicy(
			request({ session: session({ modelRoles: { definition: "openai/gpt-4o" } }) }),
		);
		expect(definitionPolicy.modelRole).toBe("definition");
	});
	it("falls through an empty host selector to the agent definition role", async () => {
		const customAgent = { ...AGENT, model: ["@definition"] };
		mockDiscovery(customAgent);
		const childSession = session({ modelRoles: { definition: "openai/gpt-4o" } });

		const policy = await resolveEffectiveSubagentPolicy(request({ session: childSession, hostModel: "" }));

		expect(policy.modelRole).toBe("definition");
		expect(policy.modelOverride).toEqual(["openai/gpt-4o"]);
	});

	it.each([
		"@review",
		"default",
		"inherit:low",
		"anthropic/*",
		"anthropic/claude-sonnet",
		"anthropic/claude-sonnet-4-5,anthropic/claude-opus-4-5",
	])("rejects a non-exact per-call selector %s", async model => {
		mockDiscovery();
		const childSession = {
			...session({ modelRoles: { review: "anthropic/claude-sonnet-4-5" } }),
			modelRegistry: { getAvailable: () => [MODEL] },
		} as ToolSession;
		await expect(resolveEffectiveSubagentPolicy(request({ session: childSession, model }))).rejects.toThrow(/model/);
	});

	it("fails a per-call selector that matches no available model", async () => {
		mockDiscovery({ ...AGENT, model: ["@definition"] });
		const childSession = session({
			modelRoles: { definition: "openai/gpt-4o", review: "anthropic/claude-sonnet-4-5" },
		});
		const registry = { getAvailable: () => [MODEL] } as unknown as ToolSession["modelRegistry"];
		const withRegistry = { ...childSession, modelRegistry: registry } as ToolSession;

		await expect(
			resolveEffectiveSubagentPolicy(request({ session: withRegistry, model: "openai/does-not-exist" })),
		).rejects.toThrow(/No available model matches `model`/);

		const policy = await resolveEffectiveSubagentPolicy(
			request({ session: withRegistry, model: "anthropic/claude-sonnet-4-5" }),
		);
		expect(policy.modelOverride).toEqual(["anthropic/claude-sonnet-4-5"]);
	});

	it("uses an exact parent selector without substituting the configured default role", async () => {
		mockDiscovery({ ...AGENT, model: ["@definition"] });
		const childSession = {
			...session({ modelRoles: { default: "openai/gpt-4o", definition: "anthropic/claude-sonnet-4-5" } }),
			getActiveModelString: () => "anthropic/claude-sonnet-4-5",
			getModelString: () => "openai/gpt-4o",
			modelRegistry: { getAvailable: () => [MODEL] },
		} as ToolSession;
		const policy = await resolveEffectiveSubagentPolicy(
			request({ session: childSession, model: "anthropic/claude-sonnet-4-5" }),
		);
		expect(policy.modelOverride).toEqual(["anthropic/claude-sonnet-4-5"]);
		expect(policy.modelRole).toBeUndefined();
	});

	it("withholds the parent credential fallback from exact per-call models", async () => {
		mockDiscovery();
		const parent = "anthropic/claude-sonnet-4-5";
		const childSession = { ...session(), getActiveModelString: () => parent } as ToolSession;
		const dispatched: executorModule.ExecutorOptions[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			dispatched.push(options);
			return result();
		});
		for (const model of ["openai/gpt-4o", parent, undefined]) {
			await runStructuredSubagent(request({ session: childSession, model }));
		}
		expect(dispatched.map(options => options.parentActiveModelPattern)).toEqual([undefined, undefined, parent]);
		expect(dispatched.map(options => options.perCallModelGrants !== undefined)).toEqual([true, true, false]);
	});

	it("preserves ordered host model alternatives when the first configured role is unavailable", async () => {
		mockDiscovery({ ...AGENT, model: ["@definition"] });
		const childSession = {
			...session({ modelRoles: { smol: "openai/gpt-4o", definition: "openai/gpt-4o" } }),
			modelRegistry: { getAvailable: () => [MODEL] },
		} as ToolSession;
		const policy = await resolveEffectiveSubagentPolicy(
			request({ session: childSession, hostModel: ["@smol", "anthropic/claude-sonnet-4-5"] }),
		);
		const selected = resolveModelOverride(
			normalizeModelPatternList(policy.modelOverride),
			{ getAvailable: () => [MODEL] },
			childSession.settings,
		);
		expect(selected.model).toBe(MODEL);
		expect(policy.perCallModelGrants).toBeUndefined();
	});

	it("falls through an empty configured override to the agent definition role", async () => {
		const customAgent = { ...AGENT, model: ["@definition"] };
		mockDiscovery(customAgent);
		const childSession = session({ modelRoles: { definition: "openai/gpt-4o" } });
		cfgTaskAgentModelOverrides.override(childSession.settings, { worker: "" });

		const policy = await resolveEffectiveSubagentPolicy(request({ session: childSession }));

		expect(policy.modelRole).toBe("definition");
		expect(policy.modelOverride).toEqual(["openai/gpt-4o"]);
	});
	it("falls through a configured alias that expands to no patterns", async () => {
		const customAgent = { ...AGENT, model: ["@definition"] };
		mockDiscovery(customAgent);
		const childSession = session({ modelRoles: { empty: "", definition: "openai/gpt-4o" } });
		cfgTaskAgentModelOverrides.override(childSession.settings, { worker: "@empty" });

		const policy = await resolveEffectiveSubagentPolicy(request({ session: childSession }));

		expect(policy.modelRole).toBe("definition");
		expect(policy.modelOverride).toEqual(["openai/gpt-4o"]);
	});

	it("lets before_subagent_spawn replace model patterns at dispatch without dropping role identity", async () => {
		mockDiscovery({ ...AGENT, model: ["@definition"] });
		const childSession = session({ modelRoles: { definition: "anthropic/claude-opus-4-5" } });
		const events: BeforeSubagentSpawnEvent[] = [];
		childSession.emitBeforeSubagentSpawn = async event => {
			events.push(event);
			return { model: "openai/gpt-4o", note: "pool test" };
		};
		const dispatched: executorModule.ExecutorOptions[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			dispatched.push(options);
			return result();
		});

		// Frontend preflight is side-effect free: stateful routers must not advance.
		await resolveEffectiveSubagentPolicy(request({ session: childSession }));
		expect(events).toEqual([]);

		const settled = await runStructuredSubagent(request({ session: childSession, retainArtifacts: true }));
		expect(dispatched[0]).toMatchObject({
			modelOverride: ["openai/gpt-4o"],
			modelRole: "definition",
			modelRoute: "pool test",
		});
		expect(events).toEqual([
			{
				type: "before_subagent_spawn",
				agent: "worker",
				invocationKind: "task",
				modelRole: "definition",
				patterns: ["anthropic/claude-opus-4-5"],
			},
		]);
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("rejects dispatch before leasing artifacts when an extension blocks the spawn", async () => {
		mockDiscovery();
		const blockedSession = session();
		blockedSession.emitBeforeSubagentSpawn = async () => ({ block: true, reason: "pool exhausted" });
		const run = vi.spyOn(executorModule, "runSubprocess");
		const error = await runStructuredSubagent(request({ session: blockedSession })).catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(StructuredSubagentError);
		expect(error as StructuredSubagentError).toMatchObject({ kind: "preflight", message: "pool exhausted" });
		expect(run).not.toHaveBeenCalled();
		expect(artifactsDirsFromRegistry()).toEqual([]);
	});

	it("does not assign a role when a child uses an explicit model selector", async () => {
		mockDiscovery();
		const childSession = session({ modelRoles: { reviewer: "openai/gpt-4o" } });
		const dispatched: executorModule.ExecutorOptions[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			dispatched.push(options);
			return result();
		});

		const settled = await runStructuredSubagent(
			request({ session: childSession, model: "openai/gpt-4o", retainArtifacts: true }),
		);

		expect(settled.policy.modelRole).toBeUndefined();
		expect(dispatched[0]?.modelRole).toBeUndefined();
		expect(settled.result.modelRole).toBeUndefined();
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("leases temporary artifacts for a retained invocation and registers them for agent URLs", async () => {
		mockDiscovery();
		let artifactsDir: string | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			artifactsDir = options.artifactsDir;
			expect(await fs.stat(options.artifactsDir ?? "")).toBeDefined();
			return result();
		});

		const settled = await runStructuredSubagent(request({ retainArtifacts: true }));
		expect(settled.temporaryArtifacts).toBe(true);
		expect(artifactsDir).toBe(settled.artifactsDir);
		expect(artifactsDirsFromRegistry()).toContain(settled.artifactsDir);
		expect(settled.result.structuredOutput).toMatchObject({
			source: "agent",
			mode: "permissive",
			data: { ok: true },
		});
		expect(path.basename(settled.artifactsDir)).toStartWith("omp-task-");
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("retains temporary artifacts when the run failed but yielded schema-valid structured output", async () => {
		// Regression: a task can produce schema-valid data and then fail (or
		// exceed its runtime limit). The async notice still advertises the
		// full payload at `agent://<id>` for schema-valid output, so
		// retention must not require `exitCode === 0` too — otherwise the
		// directory is already gone by the time the model follows that URL
		// (PR #10625 review).
		mockDiscovery();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async () => {
			return {
				...result(),
				exitCode: 1,
				error: "runtime limit exceeded",
				structuredOutput: { source: "agent", mode: "permissive", status: "valid", data: { ok: true } },
			};
		});

		const settled = await runStructuredSubagent(request({ retainArtifacts: true }));
		expect(settled.result.exitCode).toBe(1);
		expect(settled.result.structuredOutput?.status).toBe("valid");
		await expect(fs.stat(settled.artifactsDir)).resolves.toBeDefined();
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});
	it("uses identical non-plan LSP and IRC policy for task and eval invocations", async () => {
		mockDiscovery();
		const taskPolicy = await resolveEffectiveSubagentPolicy(request());
		const evalPolicy = await resolveEffectiveSubagentPolicy(request({ invocationKind: "eval" }));

		expect(evalPolicy.enableLsp).toBe(taskPolicy.enableLsp);
		expect(evalPolicy.enableIrc).toBe(taskPolicy.enableIrc);
	});

	it("rejects an invalid caller schema before executor dispatch in both modes", async () => {
		mockDiscovery();
		const dispatch = vi.spyOn(executorModule, "runSubprocess");

		for (const schemaMode of ["permissive", "strict"] as const) {
			await expect(runStructuredSubagent(request({ outputSchema: false, schemaMode }))).rejects.toThrow(
				schemaMode === "strict"
					? "Invalid strict caller output schema: boolean false schema rejects all outputs"
					: "Invalid caller output schema: boolean false schema rejects all outputs",
			);
		}
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("returns a prose answer in one turn when structured task results are disabled", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-unstructured-forwarding-"));
		const cwd = path.join(root, "project");
		await fs.mkdir(cwd, { recursive: true });
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("mock", "test-key");
		const sourceId = "structured-subagent-unstructured-regression";
		registerMockApi(sourceId);
		const report = "The direct answer is complete without a yield call.";
		const model = createMockModel({
			id: "structured-subagent-unstructured",
			handler: () => ({ content: [report] }),
		});
		const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
		const find = modelRegistry.find.bind(modelRegistry);
		modelRegistry.find = (provider, id) => (provider === "mock" && id === model.id ? model : find(provider, id));
		modelRegistry.getAvailable = () => [model];
		mockDiscovery({
			...AGENT,
			tools: ["read", "yield"],
			model: [`mock/${model.id}`],
		});
		const parentSession = Object.assign(session({ cwd }), {
			authStorage,
			modelRegistry,
			restrictToolNames: true,
			enableMCP: false,
			enableLsp: false,
			enableIrc: false,
		});
		const agentId = "UnstructuredForwarding";
		let artifactsDir: string | undefined;

		try {
			const settled = await runStructuredSubagent(
				request({
					session: parentSession,
					structured: false,
					identity: { id: agentId },
					keepAlive: false,
				}),
			);
			artifactsDir = settled.artifactsDir;

			expect(model.calls).toHaveLength(1);
			expect(model.calls[0]?.context.tools?.some(tool => tool.name === "yield") ?? false).toBe(false);
			expect(settled.result.exitCode).toBe(0);
			expect(settled.result.output).toBe(report);
			expect(settled.result.structuredOutput).toBeUndefined();
		} finally {
			const ref = AgentRegistry.global().get(agentId);
			try {
				await ref?.session?.dispose();
			} finally {
				try {
					AgentRegistry.global().unregister(agentId);
					if (artifactsDir) await fs.rm(artifactsDir, { recursive: true, force: true });
				} finally {
					unregisterCustomApis(sourceId);
					authStorage.close();
					await fs.rm(root, { recursive: true, force: true });
				}
			}
		}
	});

	it("runs the remaining permitted scout when a plan-mode task omits its agent", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-plan-default-scout-"));
		const cwd = path.join(root, "project");
		await fs.mkdir(cwd, { recursive: true });
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("mock", "test-key");
		const sourceId = "plan-default-scout-regression";
		registerMockApi(sourceId);
		const agentId = "PlanModeDefaultScout";
		let artifactDir: string | undefined;
		try {
			const report = "The permitted plan-mode scout returned this answer.";
			const model = createMockModel({
				id: "plan-default-scout",
				handler: () => ({ content: [report] }),
			});
			const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
			const find = modelRegistry.find.bind(modelRegistry);
			modelRegistry.find = (provider, id) => (provider === "mock" && id === model.id ? model : find(provider, id));
			modelRegistry.getAvailable = () => [model];
			const seanceAgent = getBundledAgent("seance");
			const scoutAgent = getBundledAgent("scout");
			if (!seanceAgent || !scoutAgent) throw new Error("Expected bundled seance and scout agents");
			vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
				agents: [
					seanceAgent,
					{
						...scoutAgent,
						model: [`mock/${model.id}`],
						tools: ["read", "yield"],
					},
				],
				projectAgentsDir: null,
			});
			const settings = Settings.isolated({
				"task.maxRecursionDepth": 2,
				"task.isolation.enabled": false,
				"task.batch": false,
				"task.structured": false,
				"task.enableLsp": false,
				"task.completionProbe": false,
				"compaction.enabled": false,
				"retry.enabled": false,
				"advisor.enabled": false,
				"autolearn.enabled": false,
				"todo.enabled": false,
			});
			const parentSession = Object.assign(session({ cwd, settings, planMode: true, parentSpawns: "seance,scout" }), {
				authStorage,
				modelRegistry,
				restrictToolNames: true,
				enableMCP: false,
				enableLsp: false,
				enableIrc: false,
			});
			const task = await TaskTool.create(parentSession);
			const result = await task.execute("plan-default-scout", {
				name: agentId,
				task: "Return the plan-mode scout answer.",
				solutionSpace: "The requested agent choice is a single permitted alternative.",
			});

			artifactDir = AgentRegistry.global().get(agentId)?.sessionFile
				? path.dirname(AgentRegistry.global().get(agentId)!.sessionFile!)
				: undefined;
			expect(result.details?.results).toHaveLength(1);
			expect(result.details?.results[0]?.agent).toBe("scout");
			expect(result.content.map(part => (part.type === "text" ? part.text : "")).join("\n")).toContain(report);
		} finally {
			const ref = AgentRegistry.global().get(agentId);
			try {
				await ref?.session?.dispose();
			} finally {
				try {
					AgentRegistry.global().unregister(agentId);
					if (artifactDir) await fs.rm(artifactDir, { recursive: true, force: true });
				} finally {
					unregisterCustomApis(sourceId);
					authStorage.close();
					await fs.rm(root, { recursive: true, force: true });
				}
			}
		}
	});

	it("does not return unavailable structured metadata without an effective schema", async () => {
		const unstructuredAgent = { ...AGENT, output: undefined };
		mockDiscovery(unstructuredAgent);
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async () => {
			const completed = result();
			completed.structuredOutput = { source: "none", mode: "permissive", status: "unavailable" };
			return completed;
		});

		const settled = await runStructuredSubagent(request({ retainArtifacts: true }));

		expect(settled.result).not.toHaveProperty("structuredOutput");
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("keeps invalid inherited schemas permissive but rejects them when session strict mode is inherited", async () => {
		const invalidAgent = { ...AGENT, output: false };
		mockDiscovery(invalidAgent);
		expect((await resolveEffectiveSubagentPolicy(request())).schema).toMatchObject({
			source: "agent",
			mode: "permissive",
		});

		const noAgentOutput = { ...AGENT, output: undefined };
		mockDiscovery(noAgentOutput);
		const strictSession = session({ outputSchema: false });
		strictSession.outputSchemaMode = "strict";
		await expect(resolveEffectiveSubagentPolicy(request({ session: strictSession }))).rejects.toThrow(
			"Invalid strict effective output schema: boolean false schema rejects all outputs",
		);
	});

	it("persists nested patch text with the compatible recovery path and wording", async () => {
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-structured-subagent-"));
		const completed = result();
		completed.patchPath = "/recovery/Worker.patch";
		completed.branchName = "omp/task/Worker";
		completed.nestedPatches = [{ relativePath: "sub/nested", patch: "diff --git a/file b/file\n" }];

		const hint = await buildStructuredSubagentRecoveryHint(completed, artifactsDir);
		const nestedPath = path.join(artifactsDir, "Worker.nested-0-sub_nested.patch");

		expect(hint).toContain("Captured patch preserved at /recovery/Worker.patch.");
		expect(hint).toContain(`Captured nested patch preserved at ${nestedPath}.`);
		expect(hint).toContain("Captured branch preserved as omp/task/Worker.");
		expect(await fs.readFile(nestedPath, "utf8")).toBe("diff --git a/file b/file\n");
		await fs.rm(artifactsDir, { recursive: true, force: true });
	});

	it("names the failure when nested patches cannot be written as a fallback", async () => {
		// `Bun.write` creates missing parents, so a genuine failure needs a path
		// that cannot become a directory: a regular file in its place.
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "omp-structured-subagent-unwritable-"));
		const artifactsDir = path.join(parent, "artifacts");
		await fs.writeFile(artifactsDir, "");
		const completed = result();
		completed.nestedPatches = [{ relativePath: "sub/nested", patch: "diff --git a/file b/file\n" }];

		const hint = await buildStructuredSubagentRecoveryHint(completed, artifactsDir);

		expect(hint).toMatch(/Nested patches could not be written: .*(ENOTDIR|EEXIST)/);
		expect(hint).not.toContain("Captured nested patch preserved");
		await fs.rm(parent, { recursive: true, force: true });
	});

	it("cleans ephemeral artifacts when isolation setup fails without recovery", async () => {
		mockDiscovery();
		vi.spyOn(isolationRunner, "prepareIsolationContext").mockRejectedValue(new Error("not a repository"));

		await expect(
			runStructuredSubagent(
				request({ session: session({ isolationEnabled: true }), isolation: { requested: true } }),
			),
		).rejects.toThrow("Isolated subagent execution could not be prepared: not a repository");
		expect(artifactsDirsFromRegistry()).toEqual([]);
	});

	it("reuses a cached output manager across concurrent allocations and sanitizes artifact ids", async () => {
		mockDiscovery();
		const sharedSession = session();
		const ids: string[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			ids.push(options.id);
			return result();
		});

		const settled = await Promise.all([
			runStructuredSubagent(
				request({ session: sharedSession, identity: { label: "../../Worker" }, retainArtifacts: true }),
			),
			runStructuredSubagent(
				request({ session: sharedSession, identity: { label: "../../Worker" }, retainArtifacts: true }),
			),
		]);

		expect(ids.sort()).toEqual(["Worker", "Worker-2"]);
		expect(sharedSession.agentOutputManager).toBeDefined();
		for (const run of settled) await fs.rm(run.artifactsDir, { recursive: true, force: true });
	});

	it("suppresses plan capability sources while preserving non-plan propagation", async () => {
		mockDiscovery();
		const mcpManager = {} as NonNullable<ToolSession["mcpManager"]>;
		const extensionPaths = ["/plugins/example.ts"];
		const preparedExtensions = [
			{
				path: extensionPaths[0]!,
				resolvedPath: extensionPaths[0]!,
				factory: () => {},
				error: null,
			},
		] as NonNullable<ToolSession["preparedExtensions"]>;
		const customToolPaths = [{ path: "/tools/example.ts", source: "project" }] as unknown as NonNullable<
			ToolSession["customToolPaths"]
		>;
		const planSession = session({ planMode: true });
		Object.assign(planSession, { mcpManager, extensionPaths, customToolPaths });
		const nonPlanSession = session();
		let explicitRoot = "/plugins/explicit";
		const extensionRoots = () => ({
			explicit: [explicitRoot],
			mode: "explicit-only" as const,
			configured: ["/plugins/configured"],
			configuredLevel: "project" as const,
		});
		Object.assign(nonPlanSession, {
			mcpManager,
			extensionPaths,
			customToolPaths,
			preparedExtensions,
			effectiveExtensionRoots: extensionRoots,
		});
		const mcpDisabledSession = session();
		mcpDisabledSession.enableMCP = false;
		const restrictedSession = session();
		const getApiKey = async () => "exact-account-key";
		Object.assign(restrictedSession, {
			restrictToolNames: true,
			getApiKey,
			mcpManager,
			extensionPaths,
			customToolPaths,
		});
		const options = [] as executorModule.ExecutorOptions[];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async executorOptions => {
			options.push(executorOptions);
			return result();
		});

		const planRun = await runStructuredSubagent(request({ session: planSession, retainArtifacts: true }));
		const nonPlanRun = await runStructuredSubagent(request({ session: nonPlanSession, retainArtifacts: true }));
		const mcpDisabledRun = await runStructuredSubagent(
			request({ session: mcpDisabledSession, retainArtifacts: true }),
		);
		const restrictedRun = await runStructuredSubagent(request({ session: restrictedSession, retainArtifacts: true }));

		expect(options[0]).toMatchObject({
			enableMCP: false,
			restrictToolNames: true,
			preloadedExtensionPaths: [],
			preloadedCustomToolPaths: [],
		});
		expect(options[0]?.mcpManager).toBeUndefined();
		expect(options[1]).toMatchObject({
			enableMCP: true,
			mcpManager,
			preloadedExtensionPaths: extensionPaths,
			preloadedPreparedExtensions: preparedExtensions,
			preloadedCustomToolPaths: customToolPaths,
		});
		expect(options[1]?.restrictToolNames).toBe(false);
		expect(options[1]?.extensionRoots?.()).toEqual(extensionRoots());
		explicitRoot = "/plugins/explicit-after-spawn";
		expect(options[1]?.extensionRoots?.().explicit).toEqual([explicitRoot]);
		expect(options[2]).toMatchObject({ enableMCP: false });
		expect(options[2]?.mcpManager).toBeUndefined();
		expect(options[3]).toMatchObject({
			enableMCP: false,
			restrictToolNames: true,
			preloadedExtensionPaths: [],
			preloadedCustomToolPaths: [],
		});
		expect(options[3]?.mcpManager).toBeUndefined();
		expect(options[3]?.getApiKey).toBe(getApiKey);
		await fs.rm(planRun.artifactsDir, { recursive: true, force: true });
		await fs.rm(nonPlanRun.artifactsDir, { recursive: true, force: true });
		await fs.rm(mcpDisabledRun.artifactsDir, { recursive: true, force: true });
		await fs.rm(restrictedRun.artifactsDir, { recursive: true, force: true });
	});

	it("unregisters and removes a temporary lease when output ID allocation fails", async () => {
		mockDiscovery();
		const failingSession = session();
		failingSession.agentOutputManager = {
			allocate: async () => {
				throw new Error("allocate failed");
			},
		} as unknown as ToolSession["agentOutputManager"];
		const remove = vi.spyOn(fs, "rm");

		await expect(runStructuredSubagent(request({ session: failingSession }))).rejects.toThrow(
			"Subagent execution failed: allocate failed",
		);

		const artifactsDir = remove.mock.calls[0]?.[0];
		expect(typeof artifactsDir).toBe("string");
		expect(artifactsDirsFromRegistry()).toEqual([]);
		await expect(fs.stat(artifactsDir as string)).rejects.toThrow();
	});

	it("unregisters and removes a temporary lease when plan reference loading fails", async () => {
		mockDiscovery();
		vi.spyOn(planHandoff, "loadOverallPlanReference").mockRejectedValue(new Error("plan unavailable"));
		const remove = vi.spyOn(fs, "rm");

		await expect(runStructuredSubagent(request())).rejects.toThrow("Subagent execution failed: plan unavailable");

		const artifactsDir = remove.mock.calls[0]?.[0];
		expect(typeof artifactsDir).toBe("string");
		expect(artifactsDirsFromRegistry()).toEqual([]);
		await expect(fs.stat(artifactsDir as string)).rejects.toThrow();
	});

	it("cleans failed nonisolated handle artifacts", async () => {
		mockDiscovery();
		let artifactsDir: string | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			artifactsDir = options.artifactsDir;
			return { ...result(), exitCode: 1, error: "agent failed" };
		});

		await runStructuredSubagent(request({ invocationKind: "eval", retainArtifacts: true }));

		expect(artifactsDirsFromRegistry()).toEqual([]);
		await expect(fs.stat(artifactsDir ?? "")).rejects.toThrow();
	});

	it("reports a run that failed before yielding as unavailable, not schema-invalid", async () => {
		// Production 2026-09-21: a scout whose model stream died mid-prose
		// ("Anthropic stream envelope error: stream ended before message_stop")
		// was delivered as `Structured output: schema invalid: <provider error>`
		// with its half-streamed text as the offending payload. No payload was
		// ever validated, so the status is "unavailable", the error is the
		// provider's, and the partial prose is not presented as data.
		mockDiscovery();
		const error = "Anthropic stream envelope error: stream ended before message_stop";
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue({
			...result(),
			exitCode: 1,
			output: "I'll systematically investigate the codebase",
			stderr: error,
			error,
		});

		const settled = await runStructuredSubagent(request());

		expect(settled.result.structuredOutput).toEqual({
			source: "agent",
			mode: "permissive",
			status: "unavailable",
			error,
		});
		expect(settled.result.structuredOutput).not.toHaveProperty("data");
	});

	it("retains a detached task's artifacts on failure even without valid structured output", async () => {
		// Regression: a detached (async) task job that fails without a valid
		// structured payload previously had its temp dir wiped immediately,
		// breaking the "failed agent stays interrogable" invariant
		// (task/index.ts) — the model could no longer read the failure via
		// agent://<id> or history://<id> (PR #10625 review).
		mockDiscovery();
		let artifactsDir: string | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			artifactsDir = options.artifactsDir;
			return { ...result(), exitCode: 1, error: "agent failed" };
		});

		const settled = await runStructuredSubagent(request({ retainArtifacts: true, detached: true }));

		expect(settled.result.exitCode).toBe(1);
		expect(settled.result.structuredOutput?.status).toBe("unavailable");
		expect(artifactsDirsFromRegistry()).toContain(settled.artifactsDir);
		await expect(fs.stat(artifactsDir ?? "")).resolves.toBeDefined();
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("retains isolated failure artifacts needed for recovery", async () => {
		mockDiscovery();
		let artifactsDir: string | undefined;
		vi.spyOn(isolationRunner, "prepareIsolationContext").mockResolvedValue({ repoRoot: "/tmp" } as never);
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async ({ baseOptions }) => {
			artifactsDir = baseOptions.artifactsDir;
			return { ...result(), exitCode: 1, error: "agent failed", patchPath: "/recovery/Worker.patch" };
		});

		const settled = await runStructuredSubagent(
			request({ session: session({ isolationEnabled: true }), isolation: { requested: true } }),
		);

		expect(artifactsDirsFromRegistry()).toContain(settled.artifactsDir);
		expect(await fs.stat(artifactsDir ?? "")).toBeDefined();
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("names the preserved branch when nested persistence fails after a branch commit", async () => {
		mockDiscovery();
		vi.spyOn(isolationRunner, "prepareIsolationContext").mockResolvedValue({ repoRoot: "/tmp" } as never);
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async () => ({
			...result(),
			branchName: "omp/task/Worker",
			branchBaseSha: "base",
			nestedPatches: [{ relativePath: "inner", patch: "diff --git a/b.txt b/b.txt\n" }],
			error: "Nested patch capture failed: ENOSPC. Isolation workspace retained at /wt/abc.",
		}));

		const settled = await runStructuredSubagent(
			request({ session: session({ isolationEnabled: true }), isolation: { requested: true } }),
		);

		expect(settled.mergeSummary).toContain("omp/task/Worker");
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("defaults task isolation to auto-apply and lets config retain artifacts", async () => {
		mockDiscovery();
		const defaultPolicy = await resolveEffectiveSubagentPolicy(
			request({ session: session({ isolationEnabled: true }), isolation: { requested: true } }),
		);
		expect(defaultPolicy.applyChanges).toBe(true);

		const capturePolicy = await resolveEffectiveSubagentPolicy(
			request({
				session: session({ isolationEnabled: true, isolationApply: false }),
				isolation: { requested: true },
			}),
		);
		expect(capturePolicy.applyChanges).toBe(false);

		const evalPolicy = await resolveEffectiveSubagentPolicy(
			request({
				invocationKind: "eval",
				session: session({ isolationEnabled: true, isolationApply: false }),
				isolation: { requested: true },
			}),
		);
		expect(evalPolicy.applyChanges).toBe(true);
	});

	it("retains successful isolated task artifacts when auto-apply is disabled", async () => {
		mockDiscovery();
		let artifactsDir: string | undefined;
		vi.spyOn(isolationRunner, "prepareIsolationContext").mockResolvedValue({ repoRoot: "/tmp" } as never);
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async ({ baseOptions }) => {
			artifactsDir = baseOptions.artifactsDir;
			return { ...result(), patchPath: "/recovery/Worker.patch" };
		});
		const merge = vi.spyOn(isolationRunner, "mergeIsolatedChanges");

		const settled = await runStructuredSubagent(
			request({
				session: session({ isolationEnabled: true, isolationApply: false }),
				isolation: { requested: true },
			}),
		);

		expect(merge).not.toHaveBeenCalled();
		expect(settled.changesApplied).toBeNull();
		expect(settled.mergeSummary).toContain("/recovery/Worker.patch");
		expect(artifactsDirsFromRegistry()).toContain(settled.artifactsDir);
		expect(await fs.stat(artifactsDir ?? "")).toBeDefined();
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});
});

describe("agent frontmatter structured opt-in", () => {
	const MOCK_API_SOURCE = "test/structured-subagent-opt-in";
	const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
	let savedEnv: Record<string, string | undefined> = {};
	let root: string;

	function restoreEnvValue(key: string, value: string | undefined): void {
		if (value === undefined) {
			delete process.env[key];
			delete Bun.env[key];
			return;
		}
		process.env[key] = value;
		Bun.env[key] = value;
	}

	/** A user agent whose `output` requires `verdict`; only the frontmatter `structured` flag varies. */
	function agentFile(name: string, structured: boolean): string {
		return [
			"---",
			`name: ${name}`,
			"description: Reports a verdict",
			"model: mock/mock-model",
			...(structured ? ["structured: true"] : []),
			"output:",
			"  properties:",
			"    verdict:",
			"      type: string",
			"  optionalProperties:",
			"    note:",
			"      type: string",
			"---",
			"",
			`Role marker ${name}.`,
		].join("\n");
	}

	beforeEach(async () => {
		savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-structured-opt-in-"));
		const home = path.join(root, "home");
		await fs.mkdir(home, { recursive: true });
		restoreEnvValue("HOME", home);
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
		for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
		__resetDirsFromEnvForTests();
		// The child sessions opened agent.db and models.db under root; Windows cannot delete open files.
		AgentStorage.close();
		closeModelCache();
		await removeWithRetries(root);
	});

	it.each([
		{ setting: false, structured: { reporter: true, plain: false } },
		{ setting: true, structured: { reporter: true, plain: true } },
	])(
		"task.structured=$setting: yield and schema follow the agent opt-in",
		async ({ setting, structured }) => {
			// Under the isolated HOME so project discovery stops before the developer's real ~/.omp.
			const cwd = path.join(root, "home", "work");
			await fs.mkdir(cwd, { recursive: true });
			const agentsDir = path.join(root, "home", ".omp", "agent", "agents");
			await Bun.write(path.join(agentsDir, "reporter.md"), agentFile("reporter", true));
			await Bun.write(path.join(agentsDir, "plain.md"), agentFile("plain", false));

			const authStorage = createInMemoryAuthStorage();
			authStorage.keys.setRuntime("mock", "test-key");
			const modelRegistry = new ModelRegistry(authStorage);
			const childTools = new Map<string, string[]>();
			const rejections = new Map<string, string>();
			const mock = createMockModel({
				handler: context => {
					const system = context.systemPrompt?.join("\n") ?? "";
					const agent = ["reporter", "plain"].find(name => system.includes(`Role marker ${name}.`));
					if (!agent) return { content: ["label"] };
					const tools = (context.tools ?? []).map(tool => tool.name);
					if (!childTools.has(agent)) childTools.set(agent, tools);
					if (!tools.includes("yield")) return { content: [`${agent} prose report`] };
					const last = context.messages.at(-1);
					if (last?.role === "toolResult" && last.toolName === "yield") {
						if (!last.isError) return { content: ["ok"] };
						rejections.set(agent, last.content.map(part => (part.type === "text" ? part.text : "")).join(""));
						return { content: [{ type: "toolCall", name: "yield", arguments: { data: { verdict: agent } } }] };
					}
					// First attempt omits the required `verdict`.
					return {
						content: [{ type: "toolCall", name: "yield", arguments: { data: { note: "no verdict yet" } } }],
					};
				},
			});
			const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
			vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [mock, ...catalogAvailable(kind)]);

			const tool = await TaskTool.create({
				cwd,
				hasUI: false,
				settings: Settings.isolated({
					"task.structured": setting,
					"async.enabled": false,
					"task.agentIdleTtlMs": 0,
					"compaction.enabled": false,
					"retry.enabled": false,
					"todo.enabled": false,
					"todo.reminders": false,
					"advisor.enabled": false,
					modelRoles: { default: "mock/mock-model" },
				}),
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				modelRegistry,
				authStorage,
				enableLsp: false,
				enableMCP: false,
				enableIrc: false,
			} as unknown as ToolSession);
			try {
				const result = await tool.execute("tc-opt-in", {
					context: "Report a verdict.",
					tasks: [
						{ agent: "reporter", name: "Reporter", task: "Report.", solutionSpace: "one fix: verdict given" },
						{ agent: "plain", name: "Plain", task: "Report.", solutionSpace: "one fix: verdict given" },
					],
				} as TaskParams);
				const results = new Map((result.details?.results ?? []).map(child => [child.agent, child]));
				for (const [agent, expectStructured] of Object.entries(structured)) {
					const child = results.get(agent);
					expect(child?.exitCode).toBe(0);
					if (expectStructured) {
						expect(childTools.get(agent)).toContain("yield");
						expect(rejections.get(agent)).toContain("does not match schema: verdict: is required");
						expect(child?.structuredOutput).toMatchObject({
							source: "agent",
							status: "valid",
							data: { verdict: agent },
						});
					} else {
						expect(childTools.get(agent)).not.toContain("yield");
						expect(rejections.has(agent)).toBe(false);
						expect(child?.output).toBe(`${agent} prose report`);
						expect(child?.structuredOutput).toBeUndefined();
					}
				}
			} finally {
				authStorage.close();
			}
		},
		30_000,
	);
});

describe("per-call selector syntax", () => {
	it.each(
		[
			null,
			42,
			true,
			{},
			[],
			["anthropic/claude-sonnet-4-5"],
			"",
			" , ",
			"@review",
			"@default",
			"anthropic/*",
			"claude-sonnet-4-5",
			"anthropic/claude-sonnet-4-5,anthropic/claude-opus-4-5",
		].map(model => ({ model })),
	)("rejects raw model input $model before selection", ({ model }) => {
		expect(invalidModelSelectorReason(model, "The call")).toMatch(/model/);
	});

	it("rejects an invalid thinking suffix instead of silently dropping it", async () => {
		mockDiscovery();
		const childSession = {
			...session(),
			getActiveModelString: () => "anthropic/claude-sonnet-4-5",
			modelRegistry: { getAvailable: () => [MODEL] },
		} as ToolSession;
		await expect(
			resolveEffectiveSubagentPolicy(request({ session: childSession, model: "anthropic/claude-sonnet-4-5:heigh" })),
		).rejects.toThrow(/thinking suffix/);
	});
});

describe("per-call model gate and approval", () => {
	const OTHER = buildModel({ ...MODEL, id: "claude-opus-4-5", name: "Claude Opus 4.5" });
	const registry = { getAvailable: () => [MODEL, OTHER] };

	function gated(settings: Record<string, unknown>, parent?: string): ToolSession {
		return {
			...session({ settings: Settings.isolated({ "task.maxRecursionDepth": 2, ...settings }) }),
			modelRegistry: registry,
			getActiveModelString: () => parent,
		} as ToolSession;
	}

	it.each(["on", "eval"])(
		"rejects a per-call model that conflicts with an exact-name override under %s",
		async mode => {
			mockDiscovery();
			const selector = "anthropic/claude-sonnet-4-5";
			const childSession = gated({ "task.perCallModel": mode, "task.agentModelOverrides": { worker: selector } });
			await expect(
				resolveEffectiveSubagentPolicy(request({ session: childSession, invocationKind: "eval", model: selector })),
			).rejects.toThrow(/task\.agentModelOverrides/);
		},
	);

	it("does not let a project agent written mid-session grant or pin its own model", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-project-model-authority-"));
		const selector = "anthropic/claude-opus-4-5";
		const parent = "anthropic/claude-sonnet-4-5";
		const childSession = { ...gated({ "task.perCallModel": "unpinned" }, parent), cwd: root };
		try {
			await resolveEffectiveSubagentPolicy(request({ session: childSession, agent: "task" }));
			await Bun.write(
				path.join(root, ".omp", "agents", "worker.md"),
				[
					"---",
					"name: worker",
					"description: Project worker",
					"source: user",
					`model: ${selector}`,
					"tools: read",
					"---",
					"Inspect the repository.",
				].join("\n"),
			);
			const ordinary = await resolveEffectiveSubagentPolicy(request({ session: childSession }));
			expect(ordinary.modelOverride).toEqual([parent]);
			expect(ordinary.effectiveAgent.systemPrompt).toContain("Inspect the repository.");
			expect(ordinary.effectiveAgent.tools).toEqual(["read"]);
			await expect(
				resolveEffectiveSubagentPolicy(request({ session: childSession, model: selector })),
			).rejects.toThrow(/not configured/);
			const selected = await resolveEffectiveSubagentPolicy(request({ session: childSession, model: parent }));
			expect(selected.modelOverride).toEqual([parent]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("rejects `model` by default and keeps ordinary routing when it is omitted", async () => {
		mockDiscovery();
		const childSession = gated({ modelRoles: { review: "anthropic/claude-sonnet-4-5" } });
		await expect(
			resolveEffectiveSubagentPolicy(request({ session: childSession, model: "anthropic/claude-sonnet-4-5" })),
		).rejects.toThrow(/task\.perCallModel: off/);
		const policy = await resolveEffectiveSubagentPolicy(request({ session: childSession }));
		expect(policy.perCallModelGrants).toBeUndefined();
	});

	it("lets host callers pass `hostModel` with `model`'s precedence while the gate is off", async () => {
		mockDiscovery({ ...AGENT, model: ["anthropic/claude-sonnet-4-5"] });
		const policy = await resolveEffectiveSubagentPolicy(
			request({ session: gated({}), hostModel: "anthropic/claude-opus-4-5" }),
		);
		expect(policy.modelOverride).toEqual(["anthropic/claude-opus-4-5"]);
		expect(policy.perCallModelGrants).toBeUndefined();
	});

	it("keeps default-role routing for trusted frontmatter and host choices while an exact per-call selector picks the parent", async () => {
		mockDiscovery({ ...AGENT, model: ["@default:high"] });
		const childSession = gated(
			{ "task.perCallModel": "on", modelRoles: { default: "anthropic/claude-sonnet-4-5" } },
			"anthropic/claude-opus-4-5",
		);
		// The parent switched to another model; calls without `model` still use the default role and its fallbacks.
		for (const host of [{}, { hostModel: "@default:high" }]) {
			const policy = await resolveEffectiveSubagentPolicy(request({ session: childSession, ...host }));
			expect(policy.modelOverride).toEqual(["anthropic/claude-sonnet-4-5:high"]);
			expect(policy.modelRole).toBe("default");
		}
		const perCall = await resolveEffectiveSubagentPolicy(
			request({ session: childSession, model: "anthropic/claude-opus-4-5:high" }),
		);
		expect(perCall.modelOverride).toEqual(["anthropic/claude-opus-4-5:high"]);
		expect(perCall.modelRole).toBeUndefined();
	});

	it("eval mode overrides a pinned reviewer only in eval while preserving its prompt, tools and grants", async () => {
		const reviewer = getBundledAgent("reviewer")!;
		mockDiscovery(reviewer);
		const childSession = gated({
			"task.perCallModel": "eval",
			"task.perCallModelAllow": ["@review"],
			modelRoles: { slow: "anthropic/claude-opus-4-5", review: "anthropic/claude-sonnet-4-5" },
		});
		const input = request({ session: childSession, agent: "reviewer" });
		const ordinary = await resolveEffectiveSubagentPolicy(input);
		expect(ordinary.modelOverride).toEqual(["anthropic/claude-opus-4-5"]);
		expect(ordinary.perCallModelGrants).toBeUndefined();
		await expect(resolveEffectiveSubagentPolicy({ ...input, model: "anthropic/claude-sonnet-4-5" })).rejects.toThrow(
			/task.perCallModel: eval/,
		);
		const overridden = await resolveEffectiveSubagentPolicy({
			...input,
			invocationKind: "eval",
			model: "anthropic/claude-sonnet-4-5",
		});
		expect(overridden.modelOverride).toEqual(["anthropic/claude-sonnet-4-5"]);
		expect(overridden.effectiveAgent.systemPrompt).toBe(ordinary.effectiveAgent.systemPrompt);
		expect(overridden.effectiveAgent.tools).toEqual(ordinary.effectiveAgent.tools);
		const grants = overridden.perCallModelGrants;
		if (!grants) throw new Error("Eval override lost its dispatch grants");
		expect(isPerCallModelApproved(MODEL, grants, registry, "dispatch")).toBe(true);
		expect(() => assertPerCallModelApproved(OTHER, grants, registry, "dispatch")).toThrow(PerCallModelError);
		await expect(
			resolveEffectiveSubagentPolicy({ ...input, invocationKind: "eval", model: "anthropic/claude-opus-4-5" }),
		).rejects.toThrow(/not configured/);
	});

	it("eval mode rejects a per-call model on an unpinned task agent", async () => {
		mockDiscovery();
		const childSession = gated({
			"task.perCallModel": "eval",
			modelRoles: { review: "anthropic/claude-sonnet-4-5" },
		});
		await expect(
			resolveEffectiveSubagentPolicy(request({ session: childSession, model: "anthropic/claude-sonnet-4-5" })),
		).rejects.toThrow(/task.perCallModel: eval/);
	});

	it("under `unpinned` rejects agents with their own model and accepts the rest", async () => {
		const settings = { "task.perCallModel": "unpinned", modelRoles: { review: "anthropic/claude-sonnet-4-5" } };
		mockDiscovery({ ...AGENT, model: ["anthropic/claude-opus-4-5"] });
		await expect(
			resolveEffectiveSubagentPolicy(request({ session: gated(settings), model: "anthropic/claude-sonnet-4-5" })),
		).rejects.toThrow(/own configured model \(frontmatter\)/);

		mockDiscovery();
		const overridden = gated({ ...settings, "task.agentModelOverrides": { worker: "@review" } });
		await expect(
			resolveEffectiveSubagentPolicy(request({ session: overridden, model: "anthropic/claude-sonnet-4-5" })),
		).rejects.toThrow(/task\.agentModelOverrides/);

		const policy = await resolveEffectiveSubagentPolicy(
			request({ session: gated(settings), model: "anthropic/claude-sonnet-4-5" }),
		);
		expect(policy.modelOverride).toEqual(["anthropic/claude-sonnet-4-5"]);
	});

	it("under `unpinned` treats the bundled `@task` model as unpinned until modelRoles.task is set", async () => {
		const settings = { "task.perCallModel": "unpinned", modelRoles: { review: "anthropic/claude-sonnet-4-5" } };
		mockDiscovery({ ...AGENT, model: ["@task"] });
		// `@task` with no modelRoles.task inherits the parent, so a per-call model is accepted.
		const policy = await resolveEffectiveSubagentPolicy(
			request({ session: gated(settings, "anthropic/claude-opus-4-5"), model: "anthropic/claude-sonnet-4-5" }),
		);
		expect(policy.modelOverride).toEqual(["anthropic/claude-sonnet-4-5"]);
		// Once the operator routes the task role, the agent is pinned.
		const routed = gated(
			{ ...settings, modelRoles: { ...settings.modelRoles, task: "anthropic/claude-opus-4-5" } },
			"anthropic/claude-sonnet-4-5",
		);
		await expect(
			resolveEffectiveSubagentPolicy(request({ session: routed, model: "anthropic/claude-sonnet-4-5" })),
		).rejects.toThrow(/own configured model \(frontmatter\)/);
	});

	it("under `unpinned` decides pinned-ness from the agent's configuration, not the parent's live model", async () => {
		const opus = "anthropic/claude-opus-4-5";
		const settings = {
			"task.perCallModel": "unpinned",
			modelRoles: { review: "anthropic/claude-sonnet-4-5", default: opus },
		};
		const resolve = (agentModel: string[], parent: string) => {
			mockDiscovery({ ...AGENT, model: agentModel });
			return resolveEffectiveSubagentPolicy(
				request({ session: gated(settings, parent), model: "anthropic/claude-sonnet-4-5" }),
			);
		};
		// A concrete frontmatter model spelling the parent's live model is still the agent's own.
		await expect(resolve([opus], opus)).rejects.toThrow(/own configured model \(frontmatter\)/);
		// `@smol` borrows modelRoles.default; the parent switching models does not change that.
		for (const parent of [opus, "anthropic/claude-sonnet-4-5"]) {
			await expect(resolve(["@smol"], parent)).rejects.toThrow(/own configured model \(frontmatter\)/);
		}
		// Parent-inheriting spellings stay unpinned whichever model the parent runs.
		for (const agentModel of [["@default"], ["*"]]) {
			await expect(resolve(agentModel, "anthropic/claude-sonnet-4-5")).resolves.toBeDefined();
		}
	});

	it("accepts configured, inherited, glob and live-parent grants and rejects a catalog-only model", async () => {
		mockDiscovery();
		const on = { "task.perCallModel": "on" };
		const resolve = (childSession: ToolSession, model: string) =>
			resolveEffectiveSubagentPolicy(request({ session: childSession, model }));

		// Authenticated and in the catalog, but no role, fallback, agent or parent names it.
		await expect(
			resolve(gated({ ...on, modelRoles: { review: "anthropic/claude-sonnet-4-5" } }), "anthropic/claude-opus-4-5"),
		).rejects.toThrow(/use an exact model approved by a configured role, bundled or user-level agent model/);
		// A configured role value.
		await expect(
			resolve(gated({ ...on, modelRoles: { review: "anthropic/claude-opus-4-5" } }), "anthropic/claude-opus-4-5"),
		).resolves.toBeDefined();
		// An unconfigured @smol borrows modelRoles.default, as the resolver does.
		const inherited = await resolve(
			gated({ ...on, modelRoles: { default: "anthropic/claude-opus-4-5" } }),
			"anthropic/claude-opus-4-5",
		);
		expect(inherited.modelOverride).toEqual(["anthropic/claude-opus-4-5"]);
		// A glob role value grants every catalog model it matches.
		await expect(
			resolve(gated({ ...on, modelRoles: { review: "anthropic/*" } }), "anthropic/claude-opus-4-5"),
		).resolves.toBeDefined();
		// A concrete retry fallback chain entry.
		await expect(
			resolve(
				gated({
					...on,
					"task.perCallModelFallbacks": "select",
					"retry.fallbackChains": { default: ["anthropic/claude-opus-4-5"] },
				}),
				"anthropic/claude-opus-4-5",
			),
		).resolves.toBeDefined();
		// The parent's live model.
		await expect(resolve(gated(on, "anthropic/claude-opus-4-5"), "anthropic/claude-opus-4-5")).resolves.toBeDefined();
	});

	it("holds every dispatch to the grants, read from current settings", () => {
		const settings = Settings.isolated({ modelRoles: { review: "anthropic/claude-sonnet-4-5" } });
		const grants = { settings, agentName: "worker" };
		expect(isPerCallModelApproved(MODEL, grants, registry, "dispatch")).toBe(true);
		expect(() => assertPerCallModelApproved(OTHER, grants, registry, "dispatch")).toThrow(PerCallModelError);
		// Revoking the role revokes the model for the next request.
		settings.setModelRole("review", "anthropic/claude-opus-4-5");
		expect(isPerCallModelApproved(MODEL, grants, registry, "dispatch")).toBe(false);
		expect(isPerCallModelApproved(OTHER, grants, registry, "dispatch")).toBe(true);
	});

	it("gives allowlist recovery guidance even when the rejected model has other configured grants", async () => {
		const deniedModel = "anthropic/claude-opus-4-5";
		mockDiscovery({ ...AGENT, model: [deniedModel] });
		const settings = {
			"task.perCallModel": "eval",
			"task.perCallModelAllow": ["@review"],
			"task.perCallModelFallbacks": "off",
			modelRoles: { review: "anthropic/claude-sonnet-4-5", slow: deniedModel },
		};
		const childSession = gated(settings, deniedModel);
		const input = request({ session: childSession, invocationKind: "eval", model: deniedModel });
		const rejected: unknown = await resolveEffectiveSubagentPolicy(input).catch(error => error);
		expect(rejected).toBeInstanceOf(StructuredSubagentError);
		if (!(rejected instanceof Error)) throw new Error("Expected the unlisted model to fail preflight");
		expect(rejected.message).toContain("use a model approved by task.perCallModelAllow");
		expect(rejected.message).toContain("replaces");
		expect(rejected.message).not.toContain("approved by a configured role");
		expect(rejected.message).not.toContain("narrows the set");
		const listed = await resolveEffectiveSubagentPolicy({ ...input, model: "anthropic/claude-sonnet-4-5" });
		expect(listed.modelOverride).toEqual(["anthropic/claude-sonnet-4-5"]);
		const withoutList = await resolveEffectiveSubagentPolicy({
			...input,
			session: gated({ ...settings, "task.perCallModelAllow": [] }, deniedModel),
		});
		expect(withoutList.modelOverride).toEqual([deniedModel]);
	});

	it("limits grants to task.perCallModelAllow, with a listed role bringing its fallback chain", () => {
		const roles = { review: "anthropic/claude-sonnet-4-5", commit: "anthropic/claude-opus-4-5" };
		const allowReview = Settings.isolated({ modelRoles: roles, "task.perCallModelAllow": ["@review"] });
		const grants = { settings: allowReview, agentName: "worker" };
		expect(isPerCallModelApproved(MODEL, grants, registry, "select")).toBe(true);
		// Configured, but not on the list.
		expect(isPerCallModelApproved(OTHER, grants, registry, "select")).toBe(false);
		// With a list set, the parent's model counts only when `@default` is listed.
		const parent = { ...grants, parentModelPattern: "anthropic/claude-opus-4-5" };
		expect(isPerCallModelApproved(OTHER, parent, registry, "select")).toBe(false);
		const withParent = Settings.isolated({ modelRoles: roles, "task.perCallModelAllow": ["@review", "@default"] });
		expect(isPerCallModelApproved(OTHER, { ...parent, settings: withParent }, registry, "select")).toBe(true);
		// With no list, the parent's model is always a grant.
		const noList = Settings.isolated({ modelRoles: { review: "anthropic/claude-sonnet-4-5" } });
		expect(isPerCallModelApproved(OTHER, { ...parent, settings: noList }, registry, "select")).toBe(true);
		const withChain = Settings.isolated({
			"task.perCallModelFallbacks": "select",
			modelRoles: roles,
			"task.perCallModelAllow": ["@review"],
			"retry.fallbackChains": { review: ["anthropic/claude-opus-4-5"] },
		});
		expect(isPerCallModelApproved(OTHER, { settings: withChain, agentName: "worker" }, registry, "select")).toBe(
			true,
		);
	});

	it("grants an allowlisted role only operator-configured values, never its built-in defaults", () => {
		// `claude-haiku-5-5` heads the built-in smol priority list; no operator setting names it.
		const builtIn = buildModel({ ...MODEL, id: "claude-haiku-5-5", name: "Claude Haiku 5.5" });
		const available = { getAvailable: () => [MODEL, OTHER, builtIn] };
		const approves = (entry: string, modelRoles: Record<string, string>, model: typeof MODEL) =>
			isPerCallModelApproved(
				model,
				{ settings: Settings.isolated({ modelRoles, "task.perCallModelAllow": [entry] }), agentName: "worker" },
				available,
				"select",
			);
		expect(approves("@smol", {}, builtIn)).toBe(false);
		// An unconfigured role still borrows the configured role the resolver borrows.
		expect(approves("@smol", { default: "anthropic/claude-sonnet-4-5" }, MODEL)).toBe(true);
		expect(approves("@smol", { default: "anthropic/claude-sonnet-4-5" }, builtIn)).toBe(false);
		expect(approves("@tiny", { smol: "anthropic/claude-opus-4-5" }, OTHER)).toBe(true);
		// The advisor borrows a configured slow role, never default.
		expect(approves("@advisor", { slow: "anthropic/claude-opus-4-5" }, OTHER)).toBe(true);
		expect(approves("@advisor", { default: "anthropic/claude-opus-4-5" }, OTHER)).toBe(false);
	});

	it("never grants built-in role defaults through a configured role value that aliases an unconfigured role", () => {
		const builtIn = buildModel({ ...MODEL, id: "claude-haiku-5-5", name: "Claude Haiku 5.5" });
		const available = { getAvailable: () => [MODEL, builtIn] };
		for (const allow of [[], ["@review"]]) {
			const approves = (modelRoles: Record<string, string>, model: typeof MODEL) =>
				isPerCallModelApproved(
					model,
					{ settings: Settings.isolated({ modelRoles, "task.perCallModelAllow": allow }), agentName: "worker" },
					available,
					"select",
				);
			// `review: "@smol"` with smol unset would route through the built-in smol list.
			expect(approves({ review: "@smol" }, builtIn)).toBe(false);
			expect(approves({ review: "@smol", default: "anthropic/claude-sonnet-4-5" }, MODEL)).toBe(true);
		}
	});

	it("matches a fuzzy grant to the provider selection prefers, not the first catalog entry", () => {
		const alpha = buildModel({ ...MODEL, provider: "alpha", id: "shared-id", name: "Shared" });
		const beta = buildModel({ ...MODEL, provider: "beta", id: "shared-id", name: "Shared" });
		const available = { getAvailable: () => [alpha, beta] };
		const settings = Settings.isolated({ modelRoles: { qa: "shared-id" }, modelProviderOrder: ["beta", "alpha"] });
		// Selection resolves `@qa` to beta, so beta is the granted model.
		expect(resolveModelOverride(["shared-id"], available, settings).model?.provider).toBe("beta");
		const grants = { settings, agentName: "worker" };
		expect(isPerCallModelApproved(beta, grants, available, "select")).toBe(true);
		expect(isPerCallModelApproved(alpha, grants, available, "select")).toBe(false);
	});

	for (const { role, roles } of [
		{ role: "review", roles: { review: "anthropic/claude-sonnet-4-5" } },
		{ role: "smol", roles: { default: "anthropic/claude-sonnet-4-5" } },
	]) {
		it.each([
			{ mode: "select", select: true, dispatch: true },
			{ mode: "runtime", select: false, dispatch: true },
			{ mode: "off", select: false, dispatch: false },
		])(`applies $mode to the default fallback inherited by an allowed @${role}`, ({ mode, select, dispatch }) => {
			const settings = Settings.isolated({
				modelRoles: roles,
				"task.perCallModelAllow": [`@${role}`],
				"task.perCallModelFallbacks": mode,
				"retry.fallbackChains": { default: ["anthropic/claude-opus-4-5"] },
			});
			const grants = { settings, agentName: "worker" };
			expect(isPerCallModelApproved(MODEL, grants, registry, "select")).toBe(true);
			expect(isPerCallModelApproved(MODEL, grants, registry, "dispatch")).toBe(true);
			expect(isPerCallModelApproved(OTHER, grants, registry, "select")).toBe(select);
			expect(isPerCallModelApproved(OTHER, grants, registry, "dispatch")).toBe(dispatch);
		});
	}

	it.each([
		{ label: "an explicitly empty chain", chain: [], ownFallback: false },
		{ label: "its own chain", chain: ["anthropic/own-fallback"], ownFallback: true },
	])("does not inherit default when an allowed role has $label", ({ chain, ownFallback }) => {
		const own = buildModel({ ...MODEL, id: "own-fallback", name: "Own Fallback" });
		const available = { getAvailable: () => [MODEL, OTHER, own] };
		const settings = Settings.isolated({
			"task.perCallModelFallbacks": "select",
			modelRoles: { review: "anthropic/claude-sonnet-4-5" },
			"task.perCallModelAllow": ["@review"],
			"retry.fallbackChains": { default: ["anthropic/claude-opus-4-5"], review: chain },
		});
		const grants = { settings, agentName: "worker" };
		for (const use of ["select", "dispatch"] as const) {
			expect(isPerCallModelApproved(MODEL, grants, available, use)).toBe(true);
			expect(isPerCallModelApproved(OTHER, grants, available, use)).toBe(false);
			expect(isPerCallModelApproved(own, grants, available, use)).toBe(ownFallback);
		}
	});

	it("inherits only the allowed role's fallback entries without granting the default primary or parent", () => {
		const configuredDefault = buildModel({ ...MODEL, id: "configured-default", name: "Configured Default" });
		const parent = buildModel({ ...MODEL, id: "parent-model", name: "Parent Model" });
		const available = { getAvailable: () => [MODEL, OTHER, configuredDefault, parent] };
		const settings = Settings.isolated({
			"task.perCallModelFallbacks": "select",
			modelRoles: {
				review: "anthropic/claude-sonnet-4-5",
				default: "anthropic/configured-default",
			},
			"task.perCallModelAllow": ["@review"],
			"retry.fallbackChains": { default: ["anthropic/claude-opus-4-5"] },
		});
		const grants = { settings, agentName: "worker", parentModelPattern: "anthropic/parent-model" };
		for (const use of ["select", "dispatch"] as const) {
			expect(isPerCallModelApproved(MODEL, grants, available, use)).toBe(true);
			expect(isPerCallModelApproved(OTHER, grants, available, use)).toBe(true);
			expect(isPerCallModelApproved(configuredDefault, grants, available, use)).toBe(false);
			expect(isPerCallModelApproved(parent, grants, available, use)).toBe(false);
		}
	});

	it.each(["@default", "*:high", "@web", "@not-a-role", "anthropic/claude-sonnet-4-5"])(
		"does not grant a default fallback through the allowlist entry %s",
		entry => {
			const settings = Settings.isolated({
				modelRoles: { default: "anthropic/claude-sonnet-4-5", web: "anthropic/claude-sonnet-4-5" },
				"task.perCallModelAllow": [entry],
				"retry.fallbackChains": { default: ["anthropic/claude-opus-4-5"] },
			});
			const grants = { settings, agentName: "worker", parentModelPattern: "anthropic/claude-sonnet-4-5" };
			expect(isPerCallModelApproved(OTHER, grants, registry, "select")).toBe(false);
			expect(isPerCallModelApproved(OTHER, grants, registry, "dispatch")).toBe(false);
		},
	);

	it("does not grant wildcard entries from an allowed role's inherited default chain", () => {
		const settings = Settings.isolated({
			modelRoles: { review: "anthropic/claude-sonnet-4-5" },
			"task.perCallModelAllow": ["@review"],
			"retry.fallbackChains": { default: ["anthropic/*"] },
		});
		const grants = { settings, agentName: "worker" };
		expect(isPerCallModelApproved(MODEL, grants, registry, "dispatch")).toBe(true);
		expect(isPerCallModelApproved(OTHER, grants, registry, "select")).toBe(false);
		expect(isPerCallModelApproved(OTHER, grants, registry, "dispatch")).toBe(false);
	});

	it("requires the live parent's exact model to be independently allowed", async () => {
		mockDiscovery();
		const parent = "anthropic/claude-opus-4-5";
		const settings = {
			"task.perCallModel": "on",
			modelRoles: { task: "anthropic/claude-sonnet-4-5" },
			"task.perCallModelAllow": ["@task"],
		};
		await expect(
			resolveEffectiveSubagentPolicy(request({ session: gated(settings, parent), model: parent })),
		).rejects.toThrow(/not configured/);
		const policy = await resolveEffectiveSubagentPolicy(
			request({
				session: gated({ ...settings, "task.perCallModelAllow": ["@task", "@default"] }, parent),
				model: parent,
			}),
		);
		expect(policy.modelOverride).toEqual([parent]);
	});

	it("only grants chat models and rejects non-chat roles and models before dispatch", async () => {
		const IMAGE = buildModel({ ...MODEL, id: "image-maker", name: "Image Maker", kind: "image" });
		const byKind = {
			getAvailable: (kind: string = "chat") =>
				[MODEL, OTHER, IMAGE].filter(model => kind === "all" || (model.kind ?? "chat") === kind),
		};
		// A chat model configured as a non-chat role (here web) is not a grant through that role.
		const asWeb = Settings.isolated({ modelRoles: { web: "anthropic/claude-opus-4-5" } });
		expect(isPerCallModelApproved(OTHER, { settings: asWeb, agentName: "worker" }, byKind, "select")).toBe(false);
		// A non-chat model never matches, even through a chat role's value.
		const imageAsReview = Settings.isolated({ modelRoles: { review: "anthropic/image-maker" } });
		expect(isPerCallModelApproved(IMAGE, { settings: imageAsReview, agentName: "worker" }, byKind, "dispatch")).toBe(
			false,
		);

		mockDiscovery();
		const childSession = {
			...session({
				settings: Settings.isolated({
					"task.perCallModel": "on",
					modelRoles: { image: "anthropic/image-maker", review: "anthropic/claude-sonnet-4-5" },
				}),
			}),
			modelRegistry: byKind,
		} as ToolSession;
		await expect(resolveEffectiveSubagentPolicy(request({ session: childSession, model: "@image" }))).rejects.toThrow(
			/model/,
		);
		await expect(
			resolveEffectiveSubagentPolicy(request({ session: childSession, model: "anthropic/image-maker" })),
		).rejects.toThrow(/is a non-chat model \(image\); a subagent needs a chat model/);
	});

	it("never grants a non-chat role's retry fallback chain", () => {
		const settings = Settings.isolated({
			modelRoles: { review: "anthropic/claude-sonnet-4-5" },
			"retry.fallbackChains": { web: ["anthropic/claude-opus-4-5"] },
		});
		expect(isPerCallModelApproved(OTHER, { settings, agentName: "worker" }, registry, "dispatch")).toBe(false);
	});

	it("grants nothing from the configured value of an allowlisted `@default` or non-chat role", () => {
		const opus = "anthropic/claude-opus-4-5";
		const settings = Settings.isolated({
			modelRoles: { review: "anthropic/claude-sonnet-4-5", default: opus, web: opus },
			"task.perCallModelAllow": ["@review", "@default", "@web"],
		});
		// `@default` grants the parent's live model (here the review model), never modelRoles.default.
		const grants = { settings, agentName: "worker", parentModelPattern: "anthropic/claude-sonnet-4-5" };
		expect(isPerCallModelApproved(MODEL, grants, registry, "select")).toBe(true);
		expect(isPerCallModelApproved(OTHER, grants, registry, "select")).toBe(false);
	});

	it("applies task.perCallModelFallbacks to retry chain models", () => {
		const at = (mode: string) =>
			Settings.isolated({
				modelRoles: { review: "anthropic/claude-sonnet-4-5" },
				"retry.fallbackChains": { review: ["anthropic/claude-opus-4-5"] },
				"task.perCallModelFallbacks": mode,
			});
		const check = (mode: string, use: "select" | "dispatch") =>
			isPerCallModelApproved(OTHER, { settings: at(mode), agentName: "worker" }, registry, use);
		expect([check("select", "select"), check("select", "dispatch")]).toEqual([true, true]);
		// Runtime only: not requestable, but the subagent may fail over to it.
		expect([check("runtime", "select"), check("runtime", "dispatch")]).toEqual([false, true]);
		// Off: the subagent fails instead of switching.
		expect([check("off", "select"), check("off", "dispatch")]).toEqual([false, false]);
	});

	it("never treats a `*` default-role alias as a catalog-wide grant", () => {
		const review = { review: "anthropic/claude-sonnet-4-5" };
		for (const { roles, agentModel } of [
			{ roles: review, agentModel: "*" },
			{ roles: review, agentModel: "*:high" },
			{ roles: { ...review, smol: "*" }, agentModel: undefined },
		]) {
			const grants = {
				settings: Settings.isolated({ modelRoles: roles }),
				agentName: "worker",
				agentModel,
				agentSource: "user" as const,
			};
			// `*` names the session's model, as `@default` does; only the configured role approves.
			expect(isPerCallModelApproved(MODEL, grants, registry, "dispatch")).toBe(true);
			expect(isPerCallModelApproved(OTHER, grants, registry, "dispatch")).toBe(false);
		}
	});

	it("runs an approved per-call model and never sends to a model an extension swaps in", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-per-call-dispatch-"));
		const cwd = path.join(root, "project");
		await fs.mkdir(cwd, { recursive: true });
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("mock", "test-key");
		const sourceId = "structured-subagent-per-call-dispatch";
		registerMockApi(sourceId);
		const approved = createMockModel({ id: "per-call-approved", handler: () => ({ content: ["approved answer"] }) });
		const swapped = createMockModel({ id: "per-call-swapped", handler: () => ({ content: ["swapped answer"] }) });
		const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
		const find = modelRegistry.find.bind(modelRegistry);
		modelRegistry.find = (provider, id) =>
			provider === "mock" ? [approved, swapped].find(model => model.id === id) : find(provider, id);
		modelRegistry.getAvailable = () => [approved, swapped];
		mockDiscovery({ ...AGENT, tools: ["read"], model: undefined });
		const parentSession = Object.assign(session({ cwd, modelRoles: { review: `mock/${approved.id}` } }), {
			authStorage,
			modelRegistry,
			restrictToolNames: true,
			enableMCP: false,
			enableLsp: false,
			enableIrc: false,
		});
		const run = async (agentId: string) => {
			try {
				return await runStructuredSubagent(
					request({
						session: parentSession,
						model: `mock/${approved.id}`,
						structured: false,
						identity: { id: agentId },
						keepAlive: false,
					}),
				);
			} finally {
				await AgentRegistry.global().get(agentId)?.session?.dispose();
				AgentRegistry.global().unregister(agentId);
			}
		};

		try {
			const ran = await run("PerCallApproved");
			expect(ran.result.exitCode).toBe(0);
			expect(ran.result.output).toBe("approved answer");
			expect(approved.calls).toHaveLength(1);

			// The spawn hook may replace the model; the replacement is held to the grants before the session starts.
			parentSession.emitBeforeSubagentSpawn = async () => ({ model: `mock/${swapped.id}` });
			const refused = await run("PerCallSwapped");
			expect(refused.result.exitCode).not.toBe(0);
			expect(`${refused.result.error ?? ""}${refused.result.stderr}`).toContain(
				'is not configured for agent "worker"',
			);
			expect(swapped.calls).toHaveLength(0);
		} finally {
			unregisterCustomApis(sourceId);
			authStorage.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 30_000);

	it.each([
		{ label: "default-off refuses even an approved alternate", mode: undefined, allowFallback: true },
		{
			label: "explicit runtime fallback rejects an unapproved wildcard destination",
			mode: "runtime",
			allowFallback: false,
		},
	])(
		"$label without making another model call",
		async ({ mode, allowFallback }) => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-per-call-fallback-"));
			const cwd = path.join(root, "project");
			await fs.mkdir(cwd, { recursive: true });
			const authStorage = await AuthStorage.create(":memory:");
			authStorage.keys.setRuntime("mock", "test-key");
			authStorage.keys.setRuntime("mock-alt", "test-key");
			const sourceId = "structured-subagent-per-call-fallback";
			registerMockApi(sourceId);
			const approved = createMockModel({
				id: "per-call-limited",
				responses: [{ throw: "rate limit exceeded retry-after-ms=60000" }],
				handler: () => ({ content: ["approved answer"] }),
			});
			const fallback = createMockModel({
				provider: "mock-alt",
				id: approved.id,
				handler: () => ({ content: ["fallback answer"] }),
			});
			const models = [approved, fallback];
			const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
			const find = modelRegistry.find.bind(modelRegistry);
			const hasProvider = modelRegistry.hasProvider.bind(modelRegistry);
			modelRegistry.find = (provider, id) =>
				models.find(model => model.provider === provider && model.id === id) ?? find(provider, id);
			modelRegistry.hasProvider = provider => provider === "mock-alt" || hasProvider(provider);
			modelRegistry.getAvailable = () => models;
			mockDiscovery({ ...AGENT, tools: ["read"], model: undefined });
			const settings = Settings.isolated({
				"task.maxRecursionDepth": 2,
				"task.perCallModel": "on",
				"task.isolation.enabled": false,
				"compaction.enabled": false,
				"retry.baseDelayMs": 5,
				"retry.maxDelayMs": 1_000,
				modelRoles: {
					review: `mock/${approved.id}`,
					...(allowFallback ? { backup: `mock-alt/${fallback.id}` } : {}),
				},
				...(mode ? { "task.perCallModelFallbacks": mode } : {}),
				"retry.fallbackChains": { default: ["mock-alt/*"] },
			});
			const parentSession = Object.assign(session({ cwd, settings }), {
				authStorage,
				modelRegistry,
				restrictToolNames: true,
				enableMCP: false,
				enableLsp: false,
				enableIrc: false,
			});
			const agentId = "PerCallFallback";
			try {
				const run = await runStructuredSubagent(
					request({
						session: parentSession,
						model: `mock/${approved.id}`,
						structured: false,
						identity: { id: agentId },
						keepAlive: false,
					}),
				);
				expect(approved.calls).toHaveLength(1);
				expect(fallback.calls).toHaveLength(0);
				expect(run.result.exitCode).not.toBe(0);
				if (mode === "runtime")
					expect(`${run.result.error ?? ""}${run.result.stderr}`).toContain("not an approved model");
			} finally {
				await AgentRegistry.global().get(agentId)?.session?.dispose();
				AgentRegistry.global().unregister(agentId);
				unregisterCustomApis(sourceId);
				authStorage.close();
				await fs.rm(root, { recursive: true, force: true });
			}
		},
		30_000,
	);

	it("re-checks a per-call model the executor resolves after a cold-registry preflight", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-per-call-cold-"));
		const cwd = path.join(root, "project");
		await fs.mkdir(cwd, { recursive: true });
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("mock", "test-key");
		const sourceId = "structured-subagent-per-call-cold";
		registerMockApi(sourceId);
		const primary = createMockModel({
			id: "per-call-cold-primary",
			handler: () => ({ content: ["primary answer"] }),
		});
		const chain = createMockModel({ id: "per-call-cold-chain", handler: () => ({ content: ["chain answer"] }) });
		const models = [primary, chain];
		const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
		const find = modelRegistry.find.bind(modelRegistry);
		modelRegistry.find = (provider, id) =>
			models.find(model => model.provider === provider && model.id === id) ?? find(provider, id);
		// Discovery is still running at preflight and finishes before the executor resolves the model.
		let warm = false;
		modelRegistry.getAvailable = () => (warm ? models : []);
		const runSubprocess = executorModule.runSubprocess;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(options => {
			warm = true;
			return runSubprocess(options);
		});
		mockDiscovery({ ...AGENT, tools: ["read"], model: undefined });
		const settings = Settings.isolated({
			"task.maxRecursionDepth": 2,
			"task.perCallModel": "on",
			"task.perCallModelFallbacks": "runtime",
			"task.isolation.enabled": false,
			modelRoles: { review: `mock/${primary.id}` },
			"retry.fallbackChains": { review: [`mock/${chain.id}`] },
		});
		const parentSession = Object.assign(session({ cwd, settings }), {
			authStorage,
			modelRegistry,
			restrictToolNames: true,
			enableMCP: false,
			enableLsp: false,
			enableIrc: false,
		});
		const run = async (agentId: string, model: string) => {
			warm = false;
			try {
				return (
					await runStructuredSubagent(
						request({
							session: parentSession,
							model,
							structured: false,
							identity: { id: agentId },
							keepAlive: false,
						}),
					)
				).result;
			} finally {
				await AgentRegistry.global().get(agentId)?.session?.dispose();
				AgentRegistry.global().unregister(agentId);
			}
		};

		try {
			// A runtime-only chain model cannot be the initial selection.
			const chainOnly = await run("PerCallColdChain", `mock/${chain.id}`);
			expect(chainOnly.exitCode).not.toBe(0);
			expect(`${chainOnly.error ?? ""}${chainOnly.stderr}`).toContain('is not configured for agent "worker"');
			// An approved model with a typo'd suffix fails instead of running at the default level.
			const typo = await run("PerCallColdSuffix", `mock/${primary.id}:heigh`);
			expect(typo.exitCode).not.toBe(0);
			expect(`${typo.error ?? ""}${typo.stderr}`).toMatch(/Requested exact model.*unavailable/);
			expect([primary.calls.length, chain.calls.length]).toEqual([0, 0]);

			const approved = await run("PerCallColdApproved", `mock/${primary.id}`);
			expect(approved.exitCode).toBe(0);
			expect(approved.output).toBe("primary answer");
		} finally {
			unregisterCustomApis(sourceId);
			authStorage.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 30_000);
});
