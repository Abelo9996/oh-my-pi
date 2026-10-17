/**
 * Approval for the per-call `model` selector on task items, eval `agent()` and
 * `workpool()`.
 *
 * A model-facing selector may only pick a model the operator already routes
 * to: a configured model role value, a retry fallback chain entry, the
 * selected agent's frontmatter model or `task.agentModelOverrides` entry, or
 * the parent's live model. A model that is only in the catalog, authenticated,
 * enabled, or picked by a built-in role default is not approved. Matching
 * reuses the resolver that `enabledModels` uses, so role aliases, fuzzy ids
 * and globs behave the same way here as they do everywhere else.
 */
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../config/model-registry";
import {
	filterAvailableModelsByEnabledPatterns,
	normalizeModelPatternList,
	splitRoleAliasThinkingSuffix,
} from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { cfgRetryFallbackChains } from "../session/settings";
import { cfgTaskAgentModelOverrides } from "./settings";

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
	/** The selected agent's frontmatter `model`. */
	agentModel?: string | string[];
	/** The parent session's live model selector. */
	parentModelPattern?: string;
}

function isSessionToken(pattern: string): boolean {
	const base = splitRoleAliasThinkingSuffix(pattern).base.toLowerCase();
	return base === "default" || base === "inherit";
}

/** Operator-configured selectors that approve a per-call model. */
export function perCallModelGrantPatterns(grants: PerCallModelGrants): string[] {
	const { settings, agentName } = grants;
	const overrides = cfgTaskAgentModelOverrides.get(settings);
	const sources: Array<string | string[] | undefined> = [
		// Values, not aliases: an alias resolves to one model, but every listed candidate is a grant.
		...Object.values(settings.getModelRoles()),
		// Wildcard chain entries are relative provider swaps, not models the operator named.
		...Object.values(cfgRetryFallbackChains.get(settings)).map(chain => chain.filter(entry => !entry.includes("*"))),
		grants.agentModel,
		Object.hasOwn(overrides, agentName) ? overrides[agentName] : undefined,
		grants.parentModelPattern,
	];
	const patterns = new Set<string>();
	for (const source of sources) {
		for (const pattern of normalizeModelPatternList(source)) {
			if (!isSessionToken(pattern)) patterns.add(pattern);
		}
	}
	return [...patterns];
}

function identity(model: Pick<Model<Api>, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

/** Whether `model` is one the operator routes to under the current configuration. */
export function isPerCallModelApproved(
	model: Pick<Model<Api>, "provider" | "id">,
	grants: PerCallModelGrants,
	registry: Pick<ModelRegistry, "getAvailable">,
): boolean {
	const patterns = perCallModelGrantPatterns(grants);
	// An empty list means "no restriction" to the resolver; here it means no grant.
	if (patterns.length === 0) return false;
	const target = identity(model);
	return filterAvailableModelsByEnabledPatterns(registry.getAvailable("all"), patterns, grants.settings).some(
		granted => identity(granted) === target,
	);
}

/** Throw {@link PerCallModelError} unless `model` is approved. */
export function assertPerCallModelApproved(
	model: Pick<Model<Api>, "provider" | "id">,
	grants: PerCallModelGrants,
	registry: Pick<ModelRegistry, "getAvailable">,
): void {
	if (isPerCallModelApproved(model, grants, registry)) return;
	throw new PerCallModelError(
		`Per-call model ${identity(model)} is not configured for agent "${grants.agentName}": use a configured role, fallback, agent model, task.agentModelOverrides entry, or the parent's model. Catalog or credentials alone do not approve a model.`,
	);
}
