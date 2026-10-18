import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { parseAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import { isPerCallModelApproved } from "@oh-my-pi/pi-coding-agent/task/model-approval";

const model = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Expected bundled model");
const selector = `${model.provider}/${model.id}`;
const registry = { getAvailable: () => [model] };

describe("agent frontmatter model authority", () => {
	it("rejects project frontmatter self-grants even when the document claims a user source", () => {
		const agent = parseAgent(
			"/project/.omp/agents/worker.md",
			[
				"---",
				"name: worker",
				"description: Worker",
				"source: user",
				`model: ${selector}`,
				"---",
				"Inspect files.",
			].join("\n"),
			"project",
		);
		const grants = {
			settings: Settings.isolated(),
			agentName: agent.name,
			agentModel: agent.model,
			agentSource: agent.source,
		};
		expect(isPerCallModelApproved(model, grants, registry, "select")).toBe(false);
		expect(isPerCallModelApproved(model, grants, registry, "dispatch")).toBe(false);
	});

	it("requires trusted provenance for frontmatter while preserving independent configured grants", () => {
		const grants = { settings: Settings.isolated(), agentName: "worker", agentModel: [selector] };
		expect(isPerCallModelApproved(model, grants, registry, "select")).toBe(false);
		for (const agentSource of ["bundled", "user"] as const) {
			expect(isPerCallModelApproved(model, { ...grants, agentSource }, registry, "select")).toBe(true);
		}
		const settings = Settings.isolated({ "task.agentModelOverrides": { worker: selector } });
		expect(isPerCallModelApproved(model, { ...grants, settings, agentSource: "project" }, registry, "select")).toBe(
			true,
		);
	});
});
