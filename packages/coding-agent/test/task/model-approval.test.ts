import { describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { factoryDroidRegistry } from "@oh-my-pi/pi-catalog/compat/factory-droid";
import { buildFactoryDroidModel } from "@oh-my-pi/pi-catalog/discovery";
import { parseModelPattern } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TempDir } from "@oh-my-pi/pi-utils";
import { parseAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import {
	assertPerCallModelApproved,
	isPerCallModelApproved,
	type PerCallModelGrants,
} from "@oh-my-pi/pi-coding-agent/task/model-approval";
import type { AgentSource } from "@oh-my-pi/pi-tui/tools/task";

const target = createMockModel({ id: "target" });
const other = createMockModel({ id: "other" });
const bracketed = createMockModel({ id: "glm[1m]" });
const image = { ...createMockModel({ id: "painter" }), kind: "image" as const };
const routerModel = (provider: string, id: string, baseUrl: string) =>
	buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	});
const sonnet = routerModel("openrouter", "anthropic/claude-sonnet-4.5", "https://openrouter.ai/api/v1");
const pinnedSonnet = parseModelPattern("openrouter/anthropic/claude-sonnet-4.5@anthropic", [sonnet]).model!;
// Separate catalog models: the base costs 8x the `:low` variant's input price.
const codingRouter = routerModel("nanogpt", "nanogpt/coding-router", "https://nano-gpt.com/api/v1");
const codingRouterLow = routerModel("nanogpt", "nanogpt/coding-router:low", "https://nano-gpt.com/api/v1");
const droidModel = (id: string, rotation: string[]) =>
	buildModel(
		buildFactoryDroidModel(
			factoryDroidRegistry().find(entry => entry.spec.id === id)!,
			{ apiProviders: rotation },
		),
	);
// Factory sends Fable's refusal chain to Opus 5 natively on the first-party Anthropic upstream.
const droidFable = droidModel("claude-fable-5", ["anthropic"]);
const droidVertexFable = droidModel("claude-fable-5.1", ["vertex_anthropic"]);
const droidOpus = droidModel("claude-opus-5", ["anthropic"]);
const chat = [target, other, bracketed, sonnet, codingRouter, codingRouterLow, droidFable, droidVertexFable, droidOpus];
const registry = {
	getAvailable: (kind?: string) => (kind === "chat" ? chat : [...chat, image]),
} as Parameters<typeof isPerCallModelApproved>[2];

interface Row {
	name: string;
	settings?: Record<string, unknown>;
	agentSource?: AgentSource;
	agentModel?: string[];
	agentRemoved?: boolean;
	parentModelPattern?: string;
	model?: Model;
	/** Settings injected by a subagent overlay on top of `settings`. */
	overlay?: Record<string, unknown>;
	approved: boolean;
}

const rows: Row[] = [
	{ name: "nothing configured", approved: false },
	{ name: "configured chat role value", settings: { modelRoles: { review: "mock/target" } }, approved: true },
	{ name: "role value with a level", settings: { modelRoles: { review: "mock/target:high" } }, approved: true },
	{
		name: "one candidate of a role list",
		settings: { modelRoles: { review: "mock/other,mock/target" } },
		approved: true,
	},
	{ name: "role value naming another model", settings: { modelRoles: { review: "mock/other" } }, approved: false },
	{ name: "glob role value", settings: { modelRoles: { review: "mock/*" } }, approved: true },
	{ name: "non-chat role value", settings: { modelRoles: { image: "mock/target" } }, approved: false },
	{ name: "role alias is not expanded into defaults", settings: { modelRoles: { review: "@smol" } }, approved: false },
	{ name: "bare * is @default, not a glob", settings: { modelRoles: { review: "*" } }, approved: false },
	{ name: "parent's live model", parentModelPattern: "mock/target", approved: true },
	{ name: "bundled agent frontmatter", agentSource: "bundled", agentModel: ["mock/target"], approved: true },
	{ name: "user agent frontmatter", agentSource: "user", agentModel: ["mock/target"], approved: true },
	{ name: "project agent frontmatter", agentSource: "project", agentModel: ["mock/target"], approved: false },
	{
		name: "removed agent's frontmatter",
		agentSource: "user",
		agentModel: ["mock/target"],
		agentRemoved: true,
		approved: false,
	},
	{
		name: "disabled agent's frontmatter",
		settings: { "task.disabledAgents": ["worker"] },
		agentSource: "user",
		agentModel: ["mock/target"],
		approved: false,
	},
	{
		name: "agent override entry is not a grant",
		settings: { "task.agentModelOverrides": { worker: "mock/target" } },
		approved: false,
	},
	{
		name: "retry fallback chain entry is not a grant",
		settings: { modelRoles: { review: "mock/other" }, "retry.fallbackChains": { review: ["mock/target"] } },
		approved: false,
	},
	{
		name: "allowlist narrows a granted model",
		settings: { modelRoles: { review: "mock/target" }, "task.perCallModelAllow": ["mock/other"] },
		approved: false,
	},
	{
		name: "allowlist admits a listed granted model",
		settings: { modelRoles: { review: "mock/target" }, "task.perCallModelAllow": ["mock/target"] },
		approved: true,
	},
	{ name: "allowlist alone grants nothing", settings: { "task.perCallModelAllow": ["mock/target"] }, approved: false },
	{
		name: "brackets in a literal id are not a glob",
		settings: { modelRoles: { review: "mock/glm[1m]" } },
		model: bracketed,
		approved: true,
	},
	{
		name: "a literal bracketed grant approves only itself",
		settings: { modelRoles: { review: "mock/glm[1m]" } },
		approved: false,
	},
	{
		name: "a non-chat model never qualifies",
		settings: { modelRoles: { review: "mock/*" } },
		model: image,
		approved: false,
	},
	{
		name: "an upstream-pinned role does not grant the unpinned model",
		settings: { modelRoles: { review: "openrouter/anthropic/claude-sonnet-4.5@anthropic" } },
		model: sonnet,
		approved: false,
	},
	{
		name: "an upstream-pinned role grants its pinned route",
		settings: { modelRoles: { review: "openrouter/anthropic/claude-sonnet-4.5@anthropic" } },
		model: pinnedSonnet,
		approved: true,
	},
	{
		name: "an unpinned role does not grant a pinned route",
		settings: { modelRoles: { review: "openrouter/anthropic/claude-sonnet-4.5" } },
		model: pinnedSonnet,
		approved: false,
	},
	{
		name: "an upstream-pinned parent model does not grant the unpinned model",
		parentModelPattern: "openrouter/anthropic/claude-sonnet-4.5@anthropic",
		model: sonnet,
		approved: false,
	},
	{
		name: "the allowlist keeps an upstream pin",
		settings: {
			modelRoles: { review: "openrouter/anthropic/claude-sonnet-4.5" },
			"task.perCallModelAllow": ["openrouter/anthropic/claude-sonnet-4.5@anthropic"],
		},
		model: sonnet,
		approved: false,
	},
	{
		name: "a role naming a catalog id with a level-shaped suffix does not grant the base id",
		settings: { modelRoles: { review: "nanogpt/nanogpt/coding-router:low" } },
		model: codingRouter,
		approved: false,
	},
	{
		name: "a role naming a catalog id with a level-shaped suffix grants that id",
		settings: { modelRoles: { review: "nanogpt/nanogpt/coding-router:low" } },
		model: codingRouterLow,
		approved: true,
	},
	{
		name: "an allowlisted catalog id with a level-shaped suffix admits that id",
		settings: {
			modelRoles: { review: "nanogpt/*" },
			"task.perCallModelAllow": ["nanogpt/nanogpt/coding-router:low"],
		},
		model: codingRouterLow,
		approved: true,
	},
	{
		name: "an allowlisted catalog id with a level-shaped suffix does not admit the base id",
		settings: {
			modelRoles: { review: "nanogpt/*" },
			"task.perCallModelAllow": ["nanogpt/nanogpt/coding-router:low"],
		},
		model: codingRouter,
		approved: false,
	},
	{
		name: "a model whose provider always falls back server-side needs the fallback approved",
		settings: { modelRoles: { review: "factory-droid/claude-fable-5" } },
		model: droidFable,
		approved: false,
	},
	{
		name: "a model whose server-side fallback target is approved",
		settings: { modelRoles: { review: "factory-droid/claude-fable-5", smol: "factory-droid/claude-opus-5" } },
		model: droidFable,
		approved: true,
	},
	{
		name: "a route without a server-side fallback needs no fallback approval",
		settings: { modelRoles: { review: "factory-droid/claude-fable-5.1" } },
		model: droidVertexFable,
		approved: true,
	},
	{
		name: "a subagent overlay's injected role never grants",
		overlay: { modelRoles: { advisor: "mock/target" } },
		approved: false,
	},
	{
		name: "a role the operator set still grants through a child overlay",
		settings: { modelRoles: { review: "mock/target" } },
		overlay: { modelRoles: { advisor: "mock/other" } },
		approved: true,
	},
];

describe("per-call model grants", () => {
	it.each(rows)("$name", row => {
		const grants: PerCallModelGrants = {
			settings: row.overlay
				? Settings.isolated(row.settings ?? {}).overlay(row.overlay)
				: Settings.isolated(row.settings ?? {}),
			agentName: "worker",
			agentSource: row.agentSource,
			agentModel: row.agentModel,
			agentRemoved: row.agentRemoved,
			parentModelPattern: row.parentModelPattern,
		};
		expect(isPerCallModelApproved(row.model ?? target, grants, registry)).toBe(row.approved);
	});

	it("a role removed from the operator's settings stops granting even when a child snapshotted it", () => {
		const root = Settings.isolated({ modelRoles: { review: "mock/target" } });
		// Spawn-time snapshot: the child copies the root's roles into its own overrides.
		const child = root.overlay({ modelRoles: { ...root.getModelRoles(), advisor: "mock/other" } });
		root.setModelRole("review", undefined);
		const grandchild = child.overlay({});
		expect(isPerCallModelApproved(target, { settings: grandchild, agentName: "worker" }, registry)).toBe(false);
	});

	it("never trusts a project agent file that claims a user source", () => {
		const agent = parseAgent(
			"/project/.omp/agents/worker.md",
			["---", "name: worker", "description: Worker", "source: user", "model: mock/target", "---", "Work."].join(
				"\n",
			),
			"project",
		);
		const grants = {
			settings: Settings.isolated(),
			agentName: agent.name,
			agentModel: agent.model,
			agentSource: agent.source,
		};
		expect(isPerCallModelApproved(target, grants, registry)).toBe(false);
	});

	it("names the unapproved server-side fallback target in the rejection", () => {
		const grants = {
			settings: Settings.isolated({ modelRoles: { review: "factory-droid/claude-fable-5" } }),
			agentName: "worker",
		};
		expect(() => assertPerCallModelApproved(droidFable, grants, registry)).toThrow(
			/server-side fallback to factory-droid\/claude-opus-5/,
		);
	});

	it("rejects a non-string task.perCallModelAllow entry from a config file and a runtime write", async () => {
		const tempDir = TempDir.createSync("@pi-per-call-allow-");
		try {
			const overlay = tempDir.join("overlay.yml");
			await Bun.write(overlay, "task:\n  perCallModelAllow:\n    - mock/target\n    - 42\n");
			await expect(Settings.loadIsolated({ inMemory: true, configFiles: [overlay] })).rejects.toThrow(
				"Invalid task.perCallModelAllow[1]",
			);
		} finally {
			tempDir.removeSync();
		}
		expect(() => Settings.isolated({ "task.perCallModelAllow": [{ id: "mock/target" }] })).toThrow(
			"Invalid task.perCallModelAllow[0]",
		);
	});

	it("names the allowlist in the rejection when one is set", () => {
		const grants = { settings: Settings.isolated({ "task.perCallModelAllow": ["mock/other"] }), agentName: "worker" };
		expect(() => assertPerCallModelApproved(target, grants, registry)).toThrow(/task\.perCallModelAllow/);
	});
});
