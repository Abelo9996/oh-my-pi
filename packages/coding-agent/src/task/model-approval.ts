/**
 * Approval for the per-call `model` selector on task items, eval `agent()` and
 * `workpool()`.
 *
 * A model-facing selector may only pick a model the operator already routes
 * to: a configured chat role value, a retry fallback chain entry, the
 * selected agent's frontmatter model or `task.agentModelOverrides` entry, or
 * the parent's live model. A model that is only in the catalog, authenticated,
 * enabled, picked by a built-in role default, or of another kind (image, web,
 * speech, dictation, judge) is not approved. Matching reuses the resolver that
 * `enabledModels` uses, so role aliases, fuzzy ids and globs behave the same
 * way here as they do everywhere else.
 */
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { AgentSource } from "@oh-my-pi/pi-tui/tools/task";
import type { ModelRegistry } from "../config/model-registry";
import {
	filterAvailableModelsByEnabledPatterns,
	getModelMatchPreferences,
	modelSelectionInheritsSessionModel,
	normalizeModelPatternList,
	resolveConfiguredModelPatterns,
	resolveExplicitModelRole,
	splitRoleAliasThinkingSuffix,
} from "../config/model-resolver";
import { isKindRole } from "../config/model-roles";
import type { Settings } from "../config/settings";
import { expandDefaultRetryFallbackChains } from "../session/retry-fallback-chains";
import { cfgRetryFallbackChains } from "../session/settings";
import {
	cfgTaskAgentModelOverrides,
	cfgTaskDisabledAgents,
	cfgTaskPerCallModelAllow,
	cfgTaskPerCallModelFallbacks,
} from "./settings";

/** A per-call model was rejected: not approved by the operator's configuration. */
export class PerCallModelError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PerCallModelError";
	}
}

/** Inputs that grant per-call models. Read live; nothing here is persisted as a grant. */
export interface PerCallModelGrants {
	settings: Settings;
	agentName: string;
	agentSource?: AgentSource;
	/** The selected agent's frontmatter `model`. */
	agentModel?: string | string[];
	/** The selected agent is no longer discovered (cold revival): its model and override grant nothing. */
	agentRemoved?: boolean;
	/** The parent session's live model selector. */
	parentModelPattern?: string;
}

/** `@default` in any spelling (`*`, `pi/default`, `:level`) names the session's model, never a grant; a bare `*` would otherwise match every model as a glob. */
function isSessionToken(pattern: string): boolean {
	const base = splitRoleAliasThinkingSuffix(pattern).base.toLowerCase();
	return base === "default" || base === "inherit" || modelSelectionInheritsSessionModel(pattern);
}

/**
 * `select`: a model the caller may name in `model`. `dispatch`: a model the
 * running subagent may send to, which also covers retry fallbacks.
 */
export type PerCallModelUse = "select" | "dispatch";

export function perCallModelAllowsParent(settings: Settings): boolean {
	const allow = cfgTaskPerCallModelAllow.get(settings);
	return allow.length === 0 || allow.some(entry => resolveExplicitModelRole(entry, settings) === "default");
}

/** Operator-configured selectors that approve a per-call model. */
export function perCallModelGrantPatterns(grants: PerCallModelGrants, use: PerCallModelUse): string[] {
	const { settings, agentName } = grants;
	const fallbackMode = cfgTaskPerCallModelFallbacks.get(settings);
	const withFallbacks = fallbackMode === "select" || (fallbackMode === "runtime" && use === "dispatch");
	const allow = cfgTaskPerCallModelAllow.get(settings);
	const chains = Object.entries(
		withFallbacks
			? expandDefaultRetryFallbackChains(
					cfgRetryFallbackChains.get(settings),
					allow.flatMap(entry => resolveExplicitModelRole(entry, settings) ?? []),
				)
			: {},
	).filter(([key]) => !isKindRole(key));
	// Wildcard chain entries are relative provider swaps, not models the operator named.
	const concrete = (chain: readonly string[] | undefined) => (chain ?? []).filter(entry => !entry.includes("*"));
	const overrides = cfgTaskAgentModelOverrides.get(settings);
	const parentAllowed = perCallModelAllowsParent(settings);
	// A disabled or removed agent's own model and override stop granting.
	const agentEnabled = !grants.agentRemoved && !cfgTaskDisabledAgents.get(settings).includes(agentName);
	const sources: Array<string | string[] | undefined> =
		allow.length > 0
			? // An explicit list replaces the derived grants; a listed role brings its configured values
				// (or the configured role it borrows, never built-in defaults) and its fallback chain.
				allow.flatMap(entry => {
					const role = resolveExplicitModelRole(entry, settings);
					if (!role) return [entry];
					if (role === "default" || isKindRole(role)) return [];
					return [
						...resolveConfiguredModelPatterns(entry, settings, { builtInDefaults: false }),
						...concrete(chains.find(([key]) => key === role)?.[1]),
					];
				})
			: [
					// Every listed candidate of a value is a grant; an alias in a value expands only to
					// configured roles, never to the built-in defaults an unset role would route through.
					...Object.entries(settings.getModelRoles())
						.filter(([role]) => !isKindRole(role))
						.map(([, value]) => resolveConfiguredModelPatterns(value, settings, { builtInDefaults: false })),
					...chains.map(([, chain]) => concrete(chain)),
					agentEnabled && (grants.agentSource === "bundled" || grants.agentSource === "user")
						? grants.agentModel
						: undefined,
					agentEnabled && Object.hasOwn(overrides, agentName) ? overrides[agentName] : undefined,
				];
	if (parentAllowed) sources.push(grants.parentModelPattern);
	const patterns = new Set<string>();
	for (const source of sources) {
		for (const pattern of normalizeModelPatternList(source)) {
			if (!isSessionToken(pattern)) patterns.add(pattern);
		}
	}
	return [...patterns];
}

/**
 * Settings overrides for a per-call worker's own session: under
 * `task.perCallModelFallbacks: off` it fails instead of switching models, even to
 * one another grant approves. Agents the worker spawns restore the chain's value.
 */
export function perCallModelFallbackOverrides(settings: Settings): Readonly<Record<string, unknown>> | undefined {
	return cfgTaskPerCallModelFallbacks.get(settings) === "off" ? { "retry.modelFallback": false } : undefined;
}

function identity(model: Pick<Model<Api>, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

/** Whether `model` is one the operator routes to under the current configuration. */
export function isPerCallModelApproved(
	model: Pick<Model<Api>, "provider" | "id">,
	grants: PerCallModelGrants,
	registry: Pick<ModelRegistry, "getAvailable">,
	use: PerCallModelUse,
): boolean {
	const patterns = perCallModelGrantPatterns(grants, use);
	// An empty list means "no restriction" to the resolver; here it means no grant.
	if (patterns.length === 0) return false;
	const target = identity(model);
	// Subagents run chat models only; a grant matching an image, search, speech or judge model does not count.
	// An ambiguous grant counts as the provider selection would pick, not the first catalog entry.
	return filterAvailableModelsByEnabledPatterns(
		registry.getAvailable("chat"),
		patterns,
		grants.settings,
		getModelMatchPreferences(grants.settings),
	).some(granted => identity(granted) === target);
}

/** Throw {@link PerCallModelError} unless `model` is approved. */
export function assertPerCallModelApproved(
	model: Pick<Model<Api>, "provider" | "id">,
	grants: PerCallModelGrants,
	registry: Pick<ModelRegistry, "getAvailable">,
	use: PerCallModelUse,
): void {
	if (isPerCallModelApproved(model, grants, registry, use)) return;
	const selectionGuidance =
		cfgTaskPerCallModelAllow.get(grants.settings).length > 0
			? "use a model approved by task.perCallModelAllow, which replaces the derived grants (listed-role fallback grants require task.perCallModelFallbacks: select). Other configured models, including the parent's, are not implicitly approved."
			: "use an exact model approved by a configured role, bundled or user-level agent model, task.agentModelOverrides entry, or the parent's model (fallback chain models count only with task.perCallModelFallbacks: select).";
	throw new PerCallModelError(
		use === "select"
			? `Per-call model ${identity(model)} is not configured for agent "${grants.agentName}": ${selectionGuidance} Catalog or credentials alone do not approve a model.`
			: `Per-call subagent "${grants.agentName}" cannot switch to ${identity(model)}: it is not an approved model (task.perCallModelAllow / task.perCallModelFallbacks).`,
	);
}
