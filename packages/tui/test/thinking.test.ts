import { describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core/thinking";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { factoryDroidRegistry } from "@oh-my-pi/pi-catalog/compat/factory-droid";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { assertModelSupportsEffortCeiling, clampThinkingLevelToCeiling } from "../src/thinking";

function requiredBundledModel(provider: Parameters<typeof getBundledModel>[0], id: string): Model {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Expected bundled model ${provider}/${id}`);
	return model;
}

function customReasoner(id = "custom-reasoner", api: Model["api"] = "openai-completions"): Model {
	return buildModel({
		id,
		name: id,
		api,
		provider: api === "factory-droid-agent" ? "factory-droid" : "custom",
		baseUrl: "https://example.com/v1",
		reasoning: true,
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High] },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
	});
}

const DEFERRED_LEVELS: Array<ThinkingLevel | undefined> = [undefined, ThinkingLevel.Inherit];

describe("clampThinkingLevelToCeiling", () => {
	it.each(DEFERRED_LEVELS)("does not opt unverified thinking into reasoning for %s", level => {
		const base = customReasoner();
		const model = { ...base, thinking: { ...base.thinking!, unverified: true } };
		expect(clampThinkingLevelToCeiling(model, level, Effort.Low)).toBe(level);
		expect(clampThinkingLevelToCeiling(model, ThinkingLevel.High, Effort.Low)).toBe(Effort.Low);
	});

	it.each(DEFERRED_LEVELS)("keeps budget-thinking Anthropic requests effortless for %s", level => {
		const model = requiredBundledModel("anthropic", "claude-sonnet-4-5");
		expect(model.thinking?.mode).toBe("budget");
		expect(clampThinkingLevelToCeiling(model, level, Effort.Low)).toBe(level);
	});

	it.each(DEFERRED_LEVELS)("keeps budget-thinking wire routes effortless for %s", level => {
		for (const api of ["bedrock-converse-stream", "google-generative-ai", "google-vertex"] as const) {
			const base = customReasoner("budget-reasoner", api);
			const model = { ...base, thinking: { mode: "budget" as const, efforts: [Effort.Low, Effort.High] } };
			expect(clampThinkingLevelToCeiling(model, level, Effort.Low)).toBe(level);
		}
		const entry = factoryDroidRegistry().find(candidate => candidate.spec.id === "claude-sonnet-4-5-20250929");
		if (!entry) throw new Error("Expected Factory budget-thinking registry model");
		expect(clampThinkingLevelToCeiling(buildModel(entry.spec), level, Effort.Low)).toBe(level);
	});

	it.each(DEFERRED_LEVELS)("pins verified models with unknown provider defaults for %s", level => {
		const model = customReasoner();
		expect(model.thinking?.defaultLevel).toBeUndefined();
		expect(model.thinking?.unverified).not.toBe(true);
		expect(clampThinkingLevelToCeiling(model, level, Effort.Low)).toBe(Effort.Low);
	});

	it.each(DEFERRED_LEVELS)("still pins mandatory and adaptive reasoning for %s", level => {
		for (const model of [
			requiredBundledModel("cursor", "cursor-grok-4.6"),
			requiredBundledModel("anthropic", "claude-opus-4-6"),
		]) {
			expect(clampThinkingLevelToCeiling(model, level, Effort.Low)).toBe(Effort.Low);
		}
	});

	it("keeps off on a Fireworks-only Factory DeepSeek route", () => {
		const entry = factoryDroidRegistry().find(candidate => candidate.spec.id === "deepseek-v4.1-flash");
		if (!entry) throw new Error("Expected Factory DeepSeek registry model");
		const model = buildModel({ ...entry.spec, factoryDroidApiProviders: ["fireworks"] });
		expect(clampThinkingLevelToCeiling(model, ThinkingLevel.Off, Effort.Low)).toBe(ThinkingLevel.Off);
	});

	it("pins off on custom forced-on Factory routes and rejects ceilings below their floor", () => {
		const model = {
			...customReasoner("deepseek-custom", "factory-droid-agent"),
			factoryDroidApiProviders: ["baseten"],
		};
		expect(clampThinkingLevelToCeiling(model, ThinkingLevel.Off, Effort.Low)).toBe(Effort.Low);
		expect(() => assertModelSupportsEffortCeiling(model, Effort.Minimal)).toThrow(
			"has no supported thinking effort at or below task.maxEffort=minimal",
		);
	});
});
