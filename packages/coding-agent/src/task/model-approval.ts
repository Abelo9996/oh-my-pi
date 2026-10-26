/**
 * Approval for the per-call `model` selector on task items, eval `agent()` and
 * `workpool()`.
 *
 * A model-facing selector may only pick a chat model the operator already
 * routes to: a configured chat role's value, the selected agent's own
 * frontmatter model (only when that agent is bundled or user-level), or the
 * parent's live model. Catalog membership, credentials, built-in role
 * defaults, project agent frontmatter, other agents' frontmatter and saved
 * transcripts grant nothing. `task.perCallModelAllow`, when set, narrows the
 * result to the exact models it lists.
 */
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { factoryDroidServerSideFallbackModels } from "@oh-my-pi/pi-ai/providers/factory-droid";
import type { AgentSource } from "@oh-my-pi/pi-tui/tools/task";
import type { ModelRegistry } from "../config/model-registry";
import {
	filterAvailableModelsByEnabledPatterns,
	formatModelStringWithRouting,
	normalizeModelPatternList,
	resolveExplicitModelRole,
	resolveModelOverride,
} from "../config/model-resolver";
import { isKindRole } from "../config/model-roles";
import type { Settings } from "../config/settings";
import { cfgTaskDisabledAgents, cfgTaskPerCallModelAllow } from "./settings";

/** A per-call model was rejected: not approved by the operator's configuration. */
export class PerCallModelError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PerCallModelError";
	}
}

/**
 * Inputs that grant per-call models; nothing here is persisted as a grant. `settings` is read live,
 * so a configuration change applies to the next request; the agent and parent fields are captured
 * when the child spawns (or is revived).
 */
export interface PerCallModelGrants {
	settings: Settings;
	agentName: string;
	agentSource?: AgentSource;
	/** The selected agent's frontmatter `model`. */
	agentModel?: string | string[];
	/** The selected agent is no longer discovered (cold revival): its frontmatter grants nothing. */
	agentRemoved?: boolean;
	/** The parent session's live model, as `provider/model-id` plus any `@upstream` pin. */
	parentModelPattern?: string;
}

type ApprovalRegistry = Pick<ModelRegistry, "getAvailable">;

/**
 * The one model an exact entry names: a literal catalog id wins over a `:level`
 * split, and an `@upstream` pin stays part of the identity. Undefined when the
 * entry is not an exact selector for an available chat model.
 */
function exactIdentity(entry: string, chat: Model<Api>[]): string | undefined {
	const model = resolveModelOverride([entry], { getAvailable: () => chat }, undefined, { exactOnly: true }).model;
	return model ? formatModelStringWithRouting(model) : undefined;
}

/**
 * Operator-configured selectors that grant a per-call model. Role aliases are
 * skipped rather than expanded: a configured role's value is a grant of its
 * own, and an unconfigured role would only route through built-in defaults.
 */
export function perCallModelGrantPatterns(grants: PerCallModelGrants): string[] {
	const settings = grants.settings.rootSettings();
	const { agentName } = grants;
	const trustedAgent =
		(grants.agentSource === "bundled" || grants.agentSource === "user") &&
		!grants.agentRemoved &&
		!cfgTaskDisabledAgents.get(settings).includes(agentName);
	const sources = [
		...Object.entries(settings.getModelRoles())
			.filter(([role]) => !isKindRole(role))
			.map(([, value]) => value),
		trustedAgent ? grants.agentModel : undefined,
		grants.parentModelPattern,
	];
	const patterns = new Set<string>();
	for (const source of sources) {
		for (const pattern of normalizeModelPatternList(source)) {
			const bare = pattern.toLowerCase();
			if (bare === "default" || bare === "inherit" || resolveExplicitModelRole(pattern, settings)) continue;
			patterns.add(pattern);
		}
	}
	return [...patterns];
}

/** Whether the operator's configuration names `model` itself (see {@link isPerCallModelApproved}). */
function isGranted(model: Model<Api>, grants: PerCallModelGrants, chat: Model<Api>[]): boolean {
	const settings = grants.settings.rootSettings();
	const target = formatModelStringWithRouting(model);
	if (!chat.some(candidate => candidate.provider === model.provider && candidate.id === model.id)) return false;
	const allow = cfgTaskPerCallModelAllow.get(settings);
	if (allow.length > 0 && !allow.some(entry => exactIdentity(entry.trim(), chat) === target)) return false;
	const chatRegistry = { getAvailable: () => chat };
	return perCallModelGrantPatterns(grants).some(pattern => {
		// An exact selector names one model; brackets in real ids (`glm-5.2[1m]`) never act as a glob.
		const exact = exactIdentity(pattern, chat);
		if (exact !== undefined) return exact === target;
		// Otherwise a grant approves what it routes to: every match of a glob, or the one model a selector resolves to.
		if (/[*?[]/.test(pattern)) {
			return filterAvailableModelsByEnabledPatterns(chat, [pattern], settings).some(
				granted => formatModelStringWithRouting(granted) === target,
			);
		}
		const resolved = resolveModelOverride([pattern], chatRegistry, settings).model;
		return resolved !== undefined && formatModelStringWithRouting(resolved) === target;
	});
}

/**
 * Server-side fallback targets of `model` that are not themselves granted. Factory Droid
 * sends Fable's refusal chain on the Anthropic upstream unconditionally, so the model
 * is approved only while every model it may switch to is.
 */
function unapprovedServerSideFallbacks(model: Model<Api>, grants: PerCallModelGrants, chat: Model<Api>[]): string[] {
	if (model.api !== "factory-droid-agent") return [];
	return factoryDroidServerSideFallbackModels(model as Model<"factory-droid-agent">)
		.map(id => `${model.provider}/${id}`)
		.filter(selector => {
			const fallback = chat.find(candidate => `${candidate.provider}/${candidate.id}` === selector);
			return !fallback || !isGranted(fallback, grants, chat);
		});
}

/**
 * Whether `model` is one the operator routes to under the current configuration.
 * Identities are exact: an `@upstream`-pinned route and the unpinned model are
 * different models here, in either direction, and an entry that is itself a
 * catalog id (even one ending in a level-shaped segment) names only that id.
 */
export function isPerCallModelApproved(
	model: Model<Api>,
	grants: PerCallModelGrants,
	registry: ApprovalRegistry,
): boolean {
	// Subagents run chat models only; a grant naming an image, search, speech or judge model does not count.
	const chat = registry.getAvailable("chat");
	return isGranted(model, grants, chat) && unapprovedServerSideFallbacks(model, grants, chat).length === 0;
}

/** Throw {@link PerCallModelError} unless `model` is approved. */
export function assertPerCallModelApproved(
	model: Model<Api>,
	grants: PerCallModelGrants,
	registry: ApprovalRegistry,
): void {
	const chat = registry.getAvailable("chat");
	if (isGranted(model, grants, chat)) {
		const fallbacks = unapprovedServerSideFallbacks(model, grants, chat);
		if (fallbacks.length === 0) return;
		throw new PerCallModelError(
			`Per-call model ${formatModelStringWithRouting(model)} is not approved for agent "${grants.agentName}": its provider always attaches a server-side fallback to ${fallbacks.join(", ")}, which is not approved. Approve the fallback model too, or use a model without one.`,
		);
	}
	const allowGuidance =
		cfgTaskPerCallModelAllow.get(grants.settings.rootSettings()).length > 0
			? " It must also be listed in task.perCallModelAllow."
			: "";
	throw new PerCallModelError(
		`Per-call model ${formatModelStringWithRouting(model)} is not approved for agent "${grants.agentName}": use a model named by a configured chat role, the selected agent's own frontmatter (bundled or user-level agents only), or the parent's model.${allowGuidance} Catalog or credentials alone do not approve a model.`,
	);
}
