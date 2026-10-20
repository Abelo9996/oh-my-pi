import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import type { Args } from "@oh-my-pi/pi-coding-agent/cli/args";
import { buildInitialMessage } from "@oh-my-pi/pi-coding-agent/cli/initial-message";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { renderWorkflowNotice } from "@oh-my-pi/pi-coding-agent/modes/magic-keywords";
import { submitCliPrompt } from "@oh-my-pi/pi-coding-agent/modes/skill-command";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	convertToLlm,
	SKILL_PROMPT_MESSAGE_TYPE,
	type SkillPromptDetails,
} from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

function cliArgs(messages: string[]): Args {
	return {
		messages,
		fileArgs: [],
		unknownFlags: new Map(),
		unrecognizedFlags: [],
		invalidFlagValues: [],
	};
}

type ObservedSkillTurn = {
	texts: string[];
};

// Workflowz requires active `task` and `eval` tools; keep both active so
// keyword steering exercises the notice path.
const mockTaskTool: AgentTool = {
	name: "task",
	label: "Task",
	description: "Mock task tool",
	parameters: type({}),
	execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
};

const mockEvalTool: AgentTool = {
	name: "eval",
	label: "Eval",
	description: "Mock eval tool",
	parameters: type({}),
	execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
};

describe("AgentSession skill prompt keyword steering", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession;
	const observedTurns: ObservedSkillTurn[] = [];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-agent-session-skill-keywords-");
		observedTurns.length = 0;

		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [mockTaskTool, mockEvalTool],
				messages: [],
			},
			convertToLlm,
			streamFn: (_model, context) => {
				observedTurns.push({
					texts: context.messages.map(message => {
						const content = message.content;
						if (typeof content === "string") return content;
						if (!Array.isArray(content)) return "";
						const text: string[] = [];
						for (const block of content) {
							if (block.type === "text") text.push(block.text);
						}
						return text.join("\n");
					}),
				});
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const response = createAssistantMessage("done");
					stream.push({ type: "start", partial: response });
					stream.push({ type: "done", reason: "stop", message: response });
				});
				return stream;
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		authStorage?.close();
		authStorage = undefined;
		tempDir.removeSync();
	});

	it("injects magic keyword notices and turn budgets from user-authored skill args", async () => {
		const skillPath = path.join(tempDir.path(), "deep-research.md");
		const details: SkillPromptDetails = {
			name: "deep-research",
			path: skillPath,
			args: "workflowz +500k! compare these approaches",
			lineCount: 1,
		};
		await session.promptCustomMessage({
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: `Skill body\n\n---\n\nSkill: ${skillPath}\nUser: ${details.args}`,
			display: true,
			details,
			attribution: "user",
		});

		expect(observedTurns).toHaveLength(1);
		const observedTurn = observedTurns[0];
		if (!observedTurn) throw new Error("Expected prompt context to be captured");
		expect(observedTurn.texts).toContain(`Skill body\n\n---\n\nSkill: ${skillPath}\nUser: ${details.args}`);
		expect(observedTurn.texts).toContain(
			renderWorkflowNotice({ taskBatch: true, scoutAvailable: true, evalTools: true }),
		);
		expect(session.sessionManager.getTurnBudget()).toEqual({ total: 500_000, spent: 0, hard: true });
	});

	it("expands a hidden skill from a CLI prompt before the model sees it", async () => {
		const skillPath = path.join(tempDir.path(), "implement", "SKILL.md");
		await Bun.write(
			skillPath,
			"---\nname: implement\ndescription: Implement fixes\ndisable-model-invocation: true\n---\nSKILL BODY MARKER 16506\n",
		);
		const skill: Skill = {
			name: "implement",
			description: "Implement fixes",
			filePath: skillPath,
			baseDir: path.dirname(skillPath),
			source: "test",
			hide: true,
		};
		const host = { skillCommands: new Map([["skill:implement", skill]]), session };
		await submitCliPrompt(host, "/skill:implement fix HWINFCI-10640", { streamingBehavior: "steer" });
		await submitCliPrompt(host, "Explain the change", { streamingBehavior: "steer" });

		expect(observedTurns[0]?.texts.join("\n")).toContain("SKILL BODY MARKER 16506");
		expect(observedTurns[0]?.texts.join("\n")).toContain("fix HWINFCI-10640");
		expect(observedTurns[0]?.texts.join("\n")).not.toContain("/skill:implement");
		expect(observedTurns[1]?.texts).toContain("Explain the change");
		expect(
			session.sessionManager
				.getEntries()
				.some(
					entry =>
						entry.type === "custom_message" &&
						entry.customType === SKILL_PROMPT_MESSAGE_TYPE &&
						entry.attribution === "user",
				),
		).toBe(true);
	});

	it("does not invoke a skill mentioned only in attached or piped text", async () => {
		const implementPath = path.join(tempDir.path(), "implement", "SKILL.md");
		const reviewPath = path.join(tempDir.path(), "review", "SKILL.md");
		await Bun.write(implementPath, "---\nname: implement\n---\nIMPLEMENT SKILL BODY\n");
		await Bun.write(reviewPath, "---\nname: review\n---\nREVIEW SKILL BODY\n");
		const skillCommands = new Map<string, Skill>([
			[
				"skill:implement",
				{
					name: "implement",
					description: "",
					filePath: implementPath,
					baseDir: path.dirname(implementPath),
					source: "test",
				},
			],
			[
				"skill:review",
				{
					name: "review",
					description: "",
					filePath: reviewPath,
					baseDir: path.dirname(reviewPath),
					source: "test",
				},
			],
		]);
		const host = { skillCommands, session };
		const fileText = '<file name="notes.md">\nExample: /skill:implement is documented here.\n</file>\n';
		const attached = buildInitialMessage({ parsed: cliArgs(["summarize this"]), fileText });
		if (attached.initialMessage === undefined) throw new Error("expected attached prompt");
		await submitCliPrompt(host, attached.initialMessage, { commandStart: attached.commandStart });
		expect(observedTurns[0]?.texts).toContain(attached.initialMessage);
		expect(
			session.sessionManager
				.getEntries()
				.some(entry => entry.type === "custom_message" && entry.customType === SKILL_PROMPT_MESSAGE_TYPE),
		).toBe(false);

		const explicit = buildInitialMessage({
			parsed: cliArgs(["/skill:review check this"]),
			fileText,
			stdinContent: "Quoted /skill:implement from stdin",
		});
		if (explicit.initialMessage === undefined) throw new Error("expected attached prompt");
		await submitCliPrompt(host, explicit.initialMessage, { commandStart: explicit.commandStart });
		const secondTurn = observedTurns[1]?.texts.join("\n");
		expect(secondTurn).toContain("REVIEW SKILL BODY");
		expect(secondTurn).toContain(fileText);
		expect(secondTurn).toContain("Quoted /skill:implement from stdin");
		expect(secondTurn).not.toContain("IMPLEMENT SKILL BODY");
		const piped = buildInitialMessage({
			parsed: cliArgs([]),
			stdinContent: "Discuss /skill:implement as plain text",
		});
		if (piped.initialMessage === undefined) throw new Error("expected piped prompt");
		await submitCliPrompt(host, piped.initialMessage, { commandStart: piped.commandStart });
		expect(observedTurns[2]?.texts).toContain(piped.initialMessage);
		expect(
			session.sessionManager
				.getEntries()
				.filter(entry => entry.type === "custom_message" && entry.customType === SKILL_PROMPT_MESSAGE_TYPE),
		).toHaveLength(1);
	});
});
