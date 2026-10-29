import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { $which, isRecord, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { disposeAllVmContexts } from "../../src/eval/js/context-manager";
import { disposeAllKernelSessions } from "../../src/eval/py/executor";
import { disposePyToolBridge } from "../../src/eval/py/tool-bridge";
import { ModelRegistry } from "../../src/config/model-registry";
import { ExtensionRuntime } from "../../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../../src/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "../../src/extensibility/extensions/wrapper";
import { SessionManager } from "../../src/session/session-manager";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import type { ToolSession } from "../../src/tools";
import { EvalTool } from "../../src/tools/eval";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

let tempDir: TempDir;
let settingsState: SettingsTestState;

beforeEach(() => {
	settingsState = beginSettingsTest();
	tempDir = TempDir.createSync("@eval-session-tool-timeout-");
	setAgentDir(path.join(tempDir.path(), "agent"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	await disposeAllVmContexts();
	await disposeAllKernelSessions();
	await disposePyToolBridge();
	restoreSettingsTestState(settingsState);
	tempDir.removeSync();
});

function makeSession(...tools: AgentTool[]): ToolSession {
	const sessionId = `session-tool-timeout-${crypto.randomUUID()}`;
	return {
		cwd: tempDir.path(),
		hasUI: false,
		settings: Settings.isolated({
			"async.enabled": false,
			"eval.autoProvision": false,
			"python.interpreter": Bun.env.PYTHON ?? $which("python3") ?? $which("python") ?? "",
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		getSessionId: () => sessionId,
		getEvalSessionId: () => sessionId,
		getToolByName: name => tools.find(tool => tool.name === name),
	};
}

/** A tool whose work stays in flight until the test calls `release()` (or the call is aborted). */
function slowTool(name: string): {
	tool: AgentTool;
	started: Promise<void>;
	release: () => void;
	aborted: () => boolean;
} {
	const started = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	let aborted = false;
	return {
		started: started.promise,
		release: () => released.resolve(),
		aborted: () => aborted,
		tool: {
			name,
			label: name,
			description: "Returns delegated work once released",
			parameters: type({}),
			async execute(_id, _args, signal) {
				const result = Promise.withResolvers<AgentToolResult>();
				void released.promise.then(() => result.resolve({ content: [{ type: "text", text: "review complete" }] }));
				const onAbort = () => {
					aborted = true;
					result.reject(signal?.reason);
				};
				if (signal?.aborted) onAbort();
				else signal?.addEventListener("abort", onAbort, { once: true });
				started.resolve();
				try {
					return await result.promise;
				} finally {
					signal?.removeEventListener("abort", onAbort);
				}
			},
		},
	};
}

async function warmEval(evalTool: EvalTool, language: "js" | "py"): Promise<void> {
	// Start the real worker/kernel outside the measured cell, so interpreter
	// startup cannot hide whether the delegated call reached execution.
	await evalTool.execute("warmup", { language, code: "print('ready')", timeout: 0 });
}

// Real Python kernels only under PI_PYTHON_INTEGRATION=1, like the other real-kernel suites.
const PYTHON_INTEGRATION = Bun.env.PI_PYTHON_INTEGRATION === "1";

describe("eval ordered session tool batches", () => {
	const auth = createInMemoryAuthStorage();
	afterAll(() => auth.close());
	const languages: Array<"js" | "py"> = ["js", "py"];
	const scenarios: Array<"success" | "returned error" | "thrown error" | "permission denied"> = [
		"success",
		"returned error",
		"thrown error",
		"permission denied",
	];
	for (const language of languages) {
		for (const scenario of scenarios) {
			it.skipIf(language === "py" && !PYTHON_INTEGRATION)(
				`${language}: ${scenario} preserves order and stops on failure`,
				async () => {
					const calls: string[] = [];
					const probe: AgentTool = {
						name: "probe",
						label: "Probe",
						description: "Records batch execution",
						parameters: type({ value: "string" }),
						async execute(_id, args) {
							if (!isRecord(args) || typeof args.value !== "string") throw new Error("invalid probe input");
							calls.push(args.value);
							if (args.value === "second" && scenario === "thrown error") throw new Error("probe failure");
							if (args.value === "second" && scenario === "returned error") {
								return { content: [{ type: "text", text: "probe failure" }], isError: true };
							}
							return { content: [{ type: "text", text: args.value }] };
						},
					};
					const denied: AgentTool = {
						name: "denied_probe",
						label: "Denied probe",
						description: "Must not execute",
						parameters: type({}),
						async execute() {
							calls.push("denied");
							return { content: [{ type: "text", text: "unexpected" }] };
						},
					};
					const settings = Settings.isolated({ "tools.approval": { denied_probe: "deny" } });
					const runner = new ExtensionRunner(
						[],
						new ExtensionRuntime(),
						tempDir.path(),
						SessionManager.inMemory(tempDir.path()),
						new ModelRegistry(auth),
						undefined,
						settings,
					);
					const wrapped = new ExtensionToolWrapper(denied, runner);
					const toolSession = makeSession(probe, wrapped);
					const steps = [
						{ name: "probe", args: { value: "first" } },
						scenario === "permission denied"
							? { name: "denied_probe", args: {} }
							: { name: "probe", args: { value: "second" } },
						{ name: "probe", args: { value: "third" } },
					];
					const encoded = JSON.stringify(steps);
					const code =
						language === "js"
							? `print(JSON.stringify(await batchTools(${encoded})))`
							: `import json\nprint(json.dumps(await batch_tools(json.loads(${JSON.stringify(encoded)}))))`;
					const result = await new EvalTool(toolSession).execute(`batch-${scenario}`, {
						language,
						code,
						timeout: 30,
					});
					const cell = result.details?.cells?.[0];
					if (scenario === "success") {
						expect(cell?.status).toBe("complete");
						expect(JSON.parse(cell?.output?.trim() ?? "")).toEqual(["first", "second", "third"]);
						expect(calls).toEqual(["first", "second", "third"]);
					} else {
						expect(cell?.status).toBe("error");
						expect(cell?.output).toContain(
							scenario === "permission denied" ? "blocked by user policy" : "probe failure",
						);
						expect(calls).toEqual(scenario === "permission denied" ? ["first"] : ["first", "second"]);
					}
				},
				45_000,
			);
		}

		it.skipIf(language === "py" && !PYTHON_INTEGRATION)(
			`${language}: caught returned-error exception retains ordered outputs`,
			async () => {
				const calls: string[] = [];
				const probe: AgentTool = {
					name: "probe",
					label: "Probe",
					description: "Records batch execution",
					parameters: type({ value: "string" }),
					async execute(_id, args) {
						if (!isRecord(args) || typeof args.value !== "string") throw new Error("invalid probe input");
						calls.push(args.value);
						return {
							content: [{ type: "text", text: args.value }],
							isError: args.value === "second",
						};
					},
				};
				const code =
					language === "js"
						? 'try { await batchTools([{name:"probe",args:{value:"first"}},{name:"probe",args:{value:"second"}},{name:"probe",args:{value:"third"}}]); } catch (e) { print(JSON.stringify(e.results)); }'
						: 'import json\ntry:\n    await batch_tools([{"name":"probe","args":{"value":"first"}},{"name":"probe","args":{"value":"second"}},{"name":"probe","args":{"value":"third"}}])\nexcept RuntimeError as e:\n    print(json.dumps(e.results))';
				const result = await new EvalTool(makeSession(probe)).execute("batch-results", {
					language,
					code,
					timeout: 30,
				});
				const cell = result.details?.cells?.[0];
				expect(cell?.status).toBe("complete");
				const outputs = JSON.parse(cell?.output?.trim() ?? "");
				expect(outputs).toHaveLength(2);
				expect(outputs[0]).toBe("first");
				expect(outputs[1]).toMatchObject({ text: "second", hasError: true });
				expect(calls).toEqual(["first", "second"]);
			},
			45_000,
		);

		it.skipIf(language === "py" && !PYTHON_INTEGRATION)(
			`${language}: cancellation aborts the current step without starting the next`,
			async () => {
				const slow = slowTool("probe");
				let laterCalled = false;
				const later: AgentTool = {
					name: "later",
					label: "Later",
					description: "Must not run after cancellation",
					parameters: type({}),
					async execute() {
						laterCalled = true;
						return { content: [{ type: "text", text: "unexpected" }] };
					},
				};
				const evalTool = new EvalTool(makeSession(slow.tool, later));
				await warmEval(evalTool, language);
				const code =
					language === "js"
						? 'await batchTools([{name: "probe", args: {}}, {name: "later", args: {}}])'
						: 'await batch_tools([{"name": "probe", "args": {}}, {"name": "later", "args": {}}])';
				const controller = new AbortController();
				const pending = evalTool.execute("cancel-batch", { language, code, timeout: 0 }, controller.signal);
				await slow.started;
				controller.abort(new Error("turn cancelled"));
				const result = await pending;
				expect(slow.aborted()).toBe(true);
				expect(laterCalled).toBe(false);
				expect(result.details?.cells?.[0]?.status).toBe("error");
			},
			15_000,
		);
	}
});

describe("eval delegated session tools", () => {
	for (const language of ["js", "py"] as const) {
		it.skipIf(language === "py" && !PYTHON_INTEGRATION)(
			`${language}: still aborts an awaited tool.task when the turn is cancelled`,
			async () => {
				const delegated = slowTool("task");
				const evalTool = new EvalTool(makeSession(delegated.tool));
				await warmEval(evalTool, language);
				const controller = new AbortController();
				const pending = evalTool.execute(
					"cancel-delegated-work",
					{ language, code: "print(await tool.task({}))", timeout: 1 },
					controller.signal,
				);

				await delegated.started;
				controller.abort(new Error("turn cancelled"));
				const result = await pending;
				expect(delegated.aborted()).toBe(true);
				expect(result.details?.cells?.[0]?.status).toBe("error");
				expect(result.details?.cells?.[0]?.output).not.toContain("review complete");
			},
			15_000,
		);
	}
});
