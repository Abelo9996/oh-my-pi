import * as path from "node:path";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgAsyncEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";

// Real SDK session and RPC dispatch for the progress-event tests; only the model is scripted,
// by the text of the last user message:
// - "fallback": the primary model (anthropic) fails with a retryable 503, the configured
//   fallback (openai/gpt-4o-mini) answers.
// - "rule": the first reply streams text matching the TTSR rule `no-forbidden`; later replies are clean.
// - anything else: "pong".
// A `session_before_compact` hook supplies the summary, so a manual compaction commits without a
// summarizer call.
const PRIMARY = getBundledModel("anthropic", "claude-sonnet-4-5");
const FALLBACK = getBundledModel("openai", "gpt-4o-mini");
if (!PRIMARY || !FALLBACK) throw new Error("bundled test models missing");

const cwd = process.cwd();
const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
authStorage.keys.setRuntime("anthropic", "test-key");
authStorage.keys.setRuntime("openai", "test-key");
const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
const settings = Settings.isolated({
	"compaction.keepRecentTokens": 1,
	"retry.baseDelayMs": 5,
	"retry.fallbackChains": { default: [`${FALLBACK.provider}/${FALLBACK.id}`] },
});
settings.setModelRole("default", `${PRIMARY.provider}/${PRIMARY.id}`);
cfgAsyncEnabled.set(settings, false);

const rulePath = path.join(cwd, "no-forbidden.md");
const rule: Rule = {
	name: "no-forbidden",
	path: rulePath,
	content: "Never write the forbidden word.",
	condition: ["forbidden"],
	scope: ["text"],
	_source: { provider: "test", providerName: "test", path: rulePath, level: "project" },
};

const { session } = await createAgentSession({
	cwd,
	agentDir: cwd,
	sessionManager: SessionManager.inMemory(cwd),
	authStorage,
	modelRegistry,
	settings,
	model: PRIMARY,
	disableExtensionDiscovery: true,
	skills: [],
	rules: [rule],
	contextFiles: [],
	workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
	promptTemplates: [],
	slashCommands: [],
	enableMCP: false,
	enableLsp: false,
	extensions: [
		pi => {
			pi.on("session_before_compact", async event => ({
				compaction: {
					summary: "compacted by the test hook",
					shortSummary: undefined,
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					details: {},
				},
			}));
		},
	],
});

function lastUserText(messages: readonly { role: string; content: unknown }[]): string {
	const last = messages.findLast(message => message.role === "user");
	if (!last) return "";
	if (typeof last.content === "string") return last.content;
	if (!Array.isArray(last.content)) return "";
	return last.content.map(part => (part?.type === "text" ? String(part.text) : "")).join("");
}

let ruleReplied = false;
const mock = createMockModel();
session.agent.streamFn = (model, context, options) => {
	const text = lastUserText(context.messages);
	let reply: MockResponse;
	if (text.includes("fallback")) {
		reply =
			model.provider === PRIMARY.provider && model.id === PRIMARY.id
				? { throw: "overloaded_error: provider returned error 503" }
				: { content: ["recovered on the fallback model"] };
	} else if (text.includes("rule") && !ruleReplied) {
		ruleReplied = true;
		reply = { content: ["this reply contains the forbidden word"] };
	} else {
		reply = { content: ["pong"] };
	}
	mock.push(reply);
	return mock.stream(model, context, options);
};
await runRpcMode(session);
