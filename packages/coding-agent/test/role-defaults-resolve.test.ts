import { describe, expect, test } from "bun:test";
import { roleDefaultModels } from "@oh-my-pi/pi-catalog/compat/behavior";

describe("built-in role defaults", () => {
	// Provider-qualified selectors resolve exactly or not at all. These two
	// defaults name no model their provider carries and only ever resolved by
	// fuzzy-matching a sibling id, so every user would skip them.
	test("name no retired provider-qualified id", () => {
		const defaults = Object.values(roleDefaultModels()).flat();
		expect(defaults).not.toContain("cerebras/zai-glm");
		expect(defaults).not.toContain("openai-codex/gpt-5.5");
	});
});
