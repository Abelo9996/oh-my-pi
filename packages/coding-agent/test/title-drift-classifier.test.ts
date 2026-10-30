import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { withCredentialRedaction } from "@oh-my-pi/pi-ai/providers/transform-messages";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { classifyTitleDrift } from "@oh-my-pi/pi-coding-agent/session/title-drift-classifier";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { asGlobalFetch } from "./helpers/fetch-mock";

afterEach(() => {
	vi.restoreAllMocks();
});

function makeRegistry(models: Model<Api>[], keys: Record<string, string> = {}): ModelRegistry {
	const authStorage = createInMemoryAuthStorage();
	for (const provider in keys) authStorage.keys.setRuntime(provider, keys[provider]!);
	const registry = new ModelRegistry(authStorage, "/nonexistent/title-drift-models.yml");
	vi.spyOn(registry, "getAvailable").mockReturnValue(models);
	return registry;
}

const jev = {
	id: "jev-preview",
	name: "JEV Preview",
	api: "typesafe",
	provider: "typesafe",
	baseUrl: "https://judge.example.test/",
	kind: "judge",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
} as Model<Api>;

describe("classifyTitleDrift", () => {
	it("asks the judge about the title text and recent turns, and finds a title stale below a 0.5 fit probability", async () => {
		const settings = Settings.isolated({ modelRoles: { judge: "typesafe/jev-preview" } });
		const registry = makeRegistry([jev], { typesafe: "ts-key" });
		const completeSimpleMock = vi.spyOn(ai, "completeSimple");
		const states: unknown[] = [];
		const fits = [0.31, 0.62];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (url, init) => {
				expect(String(url)).toBe("https://judge.example.test/v1/systemone");
				const body = JSON.parse(String(init?.body)) as {
					state: unknown;
					questions: Record<string, { type: string }>;
				};
				expect(body.questions.fits.type).toBe("noul");
				states.push(body.state);
				return Response.json({
					model: "jev-preview",
					answers: { fits: { type: "noul", noul: fits.shift() } },
					usage: { input_tokens: 10, output_tokens: 1 },
				});
			}),
		);
		const recent = [
			{ role: "user" as const, text: "now draft the release notes for 2.0" },
			{ role: "assistant" as const, text: "Drafted the 2.0 notes." },
		];

		const stale = await classifyTitleDrift(
			{ title: "🧪 PARSER: Fix parser recovery", recent },
			{ settings, registry, sessionId: "session-1" },
		);
		const fitting = await classifyTitleDrift(
			{ title: "Draft release notes", recent },
			{ settings, registry, sessionId: "session-1" },
		);

		expect(stale).toBe(true);
		expect(fitting).toBe(false);
		// The card is how the terminal indexes the session, not what it works on.
		expect(states).toEqual([
			{ title: "Fix parser recovery", recent },
			{ title: "Draft release notes", recent },
		]);
		expect(completeSimpleMock).not.toHaveBeenCalled();
	});

	it("redacts credentials from the judged conversation under the session's redaction policy", async () => {
		const settings = Settings.isolated({ modelRoles: { judge: "typesafe/jev-preview" } });
		const registry = makeRegistry([jev], { typesafe: "ts-key" });
		const token = `ghp_${"aB1".repeat(12)}`;
		const bodies: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (_url, init) => {
				bodies.push(String(init?.body));
				return Response.json({
					model: "jev-preview",
					answers: { fits: { type: "noul", noul: 0.9 } },
					usage: { input_tokens: 10, output_tokens: 1 },
				});
			}),
		);

		await withCredentialRedaction(true, () =>
			classifyTitleDrift(
				{ title: "Rotate the deploy token", recent: [{ role: "user", text: `rotate ${token} for deploys` }] },
				{ settings, registry, sessionId: "session-redacted" },
			),
		);

		expect(bodies).toHaveLength(1);
		expect(bodies[0]).not.toContain(token);
		expect(bodies[0]).toContain("[github_token_redacted]");
	});

	it("returns undefined instead of throwing when every judge fails", async () => {
		const settings = Settings.isolated({ modelRoles: { judge: "missing/judge" } });
		const registry = makeRegistry([]);

		expect(
			await classifyTitleDrift(
				{ title: "Fix parser recovery", recent: [{ role: "user", text: "draft the release notes" }] },
				{ settings, registry, sessionId: "s" },
			),
		).toBeUndefined();
	});
});
