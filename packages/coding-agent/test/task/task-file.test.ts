import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool, type AgentToolCall, type SpeculativeOperationSink } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { ExecutorOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { TaskLaunchSession } from "@oh-my-pi/pi-coding-agent/task/speculative-launch";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { resolveApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { type AgentProgress, isTaskToolDetails, type TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Buffer.from(digest).toString("hex");
}

describe("taskFile dispatch", () => {
	let directory: string;
	const managers: AsyncJobManager[] = [];
	const executions: ExecutorOptions[] = [];
	const gates = new Map<string, PromiseWithResolvers<void>>();
	const started = new Map<string, PromiseWithResolvers<void>>();

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-task-file-"));
		executions.length = 0;
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [
				{
					name: "task",
					description: "General-purpose task agent",
					systemPrompt: "You are a task agent.",
					source: "bundled",
				},
			],
			projectAgentsDir: null,
		});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			executions.push(options);
			started.get(options.id)?.resolve();
			await gates.get(options.id)?.promise;
			const progress: AgentProgress = {
				index: options.index,
				id: options.id,
				agent: options.agent.name,
				agentSource: options.agent.source,
				task: options.task,
				assignment: options.assignment,
				status: "completed",
				recentTools: [],
				recentOutput: [],
				toolCount: 0,
				requests: 1,
				tokens: 0,
				cost: 0,
				durationMs: 1,
			};
			options.onProgress?.(progress);
			return { ...progress, exitCode: 0, output: "Completed.", stderr: "", truncated: false };
		});
	});

	afterEach(async () => {
		for (const gate of gates.values()) gate.resolve();
		for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 1_000 });
		gates.clear();
		started.clear();
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		await fs.rm(directory, { recursive: true, force: true });
	});

	async function createTool(
		batch = false,
		manager?: AsyncJobManager,
		settings: Record<string, unknown> = {},
		cwd = directory,
	): Promise<TaskTool> {
		return TaskTool.create({
			cwd,
			hasUI: false,
			settings: Settings.isolated({
				"async.enabled": manager !== undefined,
				"task.batch": batch,
				"task.file": true,
				...settings,
			}),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			localProtocolOptions: { getArtifactsDir: () => path.join(directory, "artifacts") },
			asyncJobManager: manager,
		} as unknown as ToolSession);
	}

	it.each([false, true])("rejects file-backed dispatch when task.file is off (batch=%s)", async batch => {
		const taskFile = path.join(directory, "disabled.md");
		await Bun.write(taskFile, "File task that must not run.");
		const tool = await createTool(batch, undefined, { "task.file": false });
		const item = { name: "Disabled", taskFile };

		const result = await tool.execute("disabled-file", batch ? { context: "Context.", tasks: [item] } : item);

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("task.file");
		expect(executions).toHaveLength(0);
		const inline = await tool.execute("inline", { name: "Inline", task: "Inline remains available." });
		expect(inline.isError).not.toBe(true);
		expect(executions.map(execution => execution.assignment)).toEqual(["Inline remains available."]);
	});

	it.each([false, true])("requires approval for restricted task files (batch=%s)", async batch => {
		const restricted = path.join(directory, "restricted");
		const target = path.join(restricted, "assignment.md");
		const taskFile = path.join(directory, "assignment-link.md");
		await Bun.write(target, "Restricted assignment.");
		await fs.symlink(target, taskFile);
		const tool = await createTool(batch);
		const args = batch ? { context: "Context.", tasks: [{ task: "Inline work." }, { taskFile }] } : { taskFile };

		expect(
			resolveApproval(tool, args, "yolo", {}, undefined, { restrictedFolders: [restricted], cwd: directory }),
		).toMatchObject({ policy: "prompt", source: "restriction", override: true });
		expect(resolveApproval(tool, args, "yolo", {}).policy).toBe("allow");
	});

	it("still requires approval in a restricted working directory when the task file is outside it", async () => {
		const cwd = path.join(directory, "restricted");
		await fs.mkdir(cwd);
		const taskFile = path.join(directory, "assignment.md");
		await Bun.write(taskFile, "External assignment.");
		const tool = await createTool(false, undefined, {}, cwd);
		const restrictions = { restrictedFolders: [cwd], cwd };

		expect(resolveApproval(tool, { taskFile }, "yolo", {}, undefined, restrictions)).toMatchObject({
			policy: "prompt",
			source: "restriction",
		});
		expect(resolveApproval(tool, { task: "Inline work." }, "yolo", {}, undefined, restrictions)).toMatchObject({
			policy: "prompt",
			source: "restriction",
		});
	});

	it.each([false, true])(
		"retains the file assignment and provenance without expanding recorded model calls (batch=%s)",
		async batch => {
			const taskFile = path.join(directory, "assignment.md");
			const source = ` \r\n${"Inspect <widget> & {{literal}}: café 🦀\tdata  \r\n\r\n\r\n|cell| value |\r\n".repeat(3_000)}  \n`;
			const bytes = new TextEncoder().encode(source);
			await Bun.write(taskFile, bytes);
			const fileItem = { name: "FileTask", taskFile, solutionSpace: "Follow the supplied steps." };
			const args = batch
				? {
						context: "Shared investigation context.",
						tasks: [
							fileItem,
							{ name: "InlineTask", task: "  Inline work.\n", solutionSpace: "Follow the steps." },
						],
					}
				: fileItem;
			const expectedArgs = structuredClone(args);
			const tool = await createTool(batch);
			const mockModel = createMockModel({
				responses: [
					{ content: [{ type: "toolCall", id: "dispatch-file", name: "task", arguments: args }] },
					{ content: ["done"] },
				],
			});
			const agent = new Agent({
				initialState: {
					model: mockModel.model,
					systemPrompt: ["Test"],
					tools: [tool as unknown as AgentTool],
					messages: [],
				},
				streamFn: mockModel.stream,
			});

			await agent.prompt("Dispatch the file.");

			const recordedCall = agent.state.messages
				.flatMap(message => (message.role === "assistant" ? message.content : []))
				.find(part => part.type === "toolCall");
			expect(recordedCall?.type === "toolCall" && recordedCall.arguments).toEqual(expectedArgs);
			const toolResult = agent.state.messages.find(message => message.role === "toolResult");
			if (toolResult?.role !== "toolResult" || !isTaskToolDetails(toolResult.details)) {
				throw new Error("Expected recorded task tool result details");
			}
			expect(toolResult.isError).toBe(false);
			const assignment = source.trim();
			const dispatched = executions.find(item => item.id === "FileTask");
			expect(dispatched?.assignment).toBe(assignment);
			expect(toolResult.details.results.find(item => item.id === "FileTask")).toMatchObject({
				assignment,
				taskFile,
				taskFileSha256: await sha256(bytes),
			});
			expect(toolResult.details.progress).toBeUndefined();
			if (batch) {
				expect(executions.find(item => item.id === "InlineTask")?.assignment).toBe("Inline work.");
				expect(dispatched?.context).toBe("Shared investigation context.");
			}
		},
	);

	it("formats file and inline instructions through the same rendering path", async () => {
		const taskFile = path.join(directory, "formatted.md");
		const source = "  First instruction.  \r\n\r\n\r\nSecond instruction.\r\n  ";
		await Bun.write(taskFile, source);
		const tool = await createTool();

		const fileResult = await tool.execute("formatted-file", { name: "File", taskFile });
		const inlineResult = await tool.execute("formatted-inline", { name: "Inline", task: source });

		expect(fileResult.isError).not.toBe(true);
		expect(inlineResult.isError).not.toBe(true);
		expect(executions).toHaveLength(2);
		expect(executions[0].task).toBe(executions[1].task);
		expect(fileResult.details?.results[0]?.assignment).toBe(source.trim());
	});

	it("resolves local URLs to their backing file for approval and dispatch", async () => {
		const localRoot = path.join(directory, "artifacts", "local");
		const taskFile = "local://nested/assignment.md";
		const source = `${"x".repeat(1024 * 1024)}\nLocal task instructions.\n`;
		const bytes = new TextEncoder().encode(source);
		await Bun.write(path.join(localRoot, "nested", "assignment.md"), bytes);
		const tool = await createTool();
		const progress: AgentProgress[] = [];

		expect(
			resolveApproval(tool, { taskFile }, "yolo", {}, undefined, { restrictedFolders: [localRoot], cwd: directory }),
		).toMatchObject({ policy: "prompt", source: "restriction", override: true });
		const result = await tool.execute("local-file", { name: "Local", taskFile }, undefined, update => {
			progress.push(...(update.details?.progress ?? []));
		});

		expect(result.isError).not.toBe(true);
		expect(executions[0]?.assignment).toBe(source.trim());
		const expected = { assignment: source.trim(), taskFile, taskFileSha256: await sha256(bytes) };
		expect(result.details?.results[0]).toMatchObject(expected);
		expect(progress.at(-1)).toMatchObject(expected);
	});

	it.each([
		{ batch: false, isolation: false },
		{ batch: false, isolation: true },
		{ batch: true, isolation: false },
		{ batch: true, isolation: true },
	])(
		"dispatches files through dynamic schema normalization (batch=$batch, isolation=$isolation)",
		async ({ batch, isolation }) => {
			const taskFile = path.join(directory, "dynamic.md");
			const source = "Use the dynamically configured task tool.";
			await Bun.write(taskFile, source);
			const tool = await createTool(batch, undefined, {
				"task.enableEffort": true,
				"task.isolation.enabled": isolation,
			});
			const item = { name: "Dynamic", taskFile, effort: "hi", solutionSpace: "Follow the steps." };
			const normalized = tool.parameters(batch ? { context: "Dynamic context.", tasks: [item] } : item);
			if (normalized instanceof type.errors) throw new Error(normalized.summary);

			const result = await tool.execute("dynamic-file", normalized);

			expect(result.isError).not.toBe(true);
			expect(executions[0]?.assignment).toBe(source);
			expect(executions[0]?.effort).toBe("hi");
			expect(result.details?.results[0]?.assignment).toBe(source);
		},
	);

	it("retains the dispatch-time file and byte hash through asynchronous progress updates", async () => {
		const taskFile = path.join(directory, "async.md");
		await Bun.write(taskFile, "Stale contents before dispatch.");
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		const tool = await createTool(true, manager, { "task.maxConcurrency": 1 });
		const gate = Promise.withResolvers<void>();
		const blockerStarted = Promise.withResolvers<void>();
		gates.set("Blocker", gate);
		started.set("Blocker", blockerStarted);
		await tool.execute("blocking-job", { name: "Blocker", task: "Occupy the only execution slot." });
		await blockerStarted.promise;
		const source = "\uFEFF  Resolve the async task.\r\n\tKeep interior whitespace.\r\n  ";
		const bytes = new TextEncoder().encode(source);
		await Bun.write(taskFile, bytes);
		const updates: TaskToolDetails[] = [];

		const result = await tool.execute(
			"async-file",
			{ context: "Async context.", tasks: [{ name: "AsyncFile", taskFile }] },
			undefined,
			update => {
				if (update.details) updates.push(update.details);
			},
		);

		const expected = { assignment: source.trim(), taskFile, taskFileSha256: await sha256(bytes) };
		expect(result.details?.progress?.[0]).toMatchObject(expected);
		expect(executions.map(item => item.id)).toEqual(["Blocker"]);
		await Bun.write(taskFile, "Changed after dispatch.");
		gate.resolve();
		const job = manager.getJob("AsyncFile");
		if (!job) throw new Error(`Expected asynchronous job, received: ${textOf(result)}`);
		await job.promise;
		expect(job.status).toBe("completed");
		const dispatched = executions.find(item => item.id === "AsyncFile");
		expect(dispatched?.assignment).toBe(source.trim());
		expect(updates.at(-1)?.progress?.[0]).toMatchObject({ ...expected, status: "completed" });
	});

	it("keeps literal JSON escape sequences in file contents", async () => {
		const taskFile = path.join(directory, "literal-escapes.md");
		const source = String.raw`# Target\nKeep \"quoted\" text and \t tabs literal.`;
		await Bun.write(taskFile, source);
		const tool = await createTool();

		const result = await tool.execute("literal-escapes", { name: "LiteralEscapes", taskFile });

		expect(result.isError).not.toBe(true);
		expect(executions[0]?.assignment).toBe(source);
		expect(executions[0]?.task).toContain(source);
		expect(result.details?.results[0]?.assignment).toBe(source);
	});

	it("waits until dispatch to read files mentioned in streamed task arguments", async () => {
		const taskFile = path.join(directory, "streamed.md");
		await Bun.write(taskFile, "Stale contents during streaming.");
		const tool = await createTool(true);
		const sink: SpeculativeOperationSink = {
			maxInFlight: 2,
			admit: async () => undefined,
			authorizeLaunch: async () => ({ allowed: true }),
			close: () => {},
		};
		const toolCall: AgentToolCall = { type: "toolCall", id: "streamed-file", name: "task", arguments: {} };
		const session = await tool.speculation.stream?.open({ coordinator: sink, parentToolCallId: toolCall.id });
		if (!session) throw new Error("Expected speculative task session");
		const args = { context: "Streamed context.", tasks: [{ name: "Streamed", taskFile }] };
		session.update(toolCall, JSON.stringify(args));
		session.finalize({ toolCall, args });
		await (session as TaskLaunchSession).adopt([]);
		expect(executions).toHaveLength(0);
		const source = "Changed after the task arguments finished streaming.";
		await Bun.write(taskFile, source);

		const result = await tool.execute(toolCall.id, args);

		expect(result.isError).not.toBe(true);
		expect(executions.map(item => item.assignment)).toEqual([source]);
		expect(result.details?.results[0]?.assignment).toBe(source);
	});

	it.each([
		{ batch: false, both: false },
		{ batch: false, both: true },
		{ batch: true, both: false },
		{ batch: true, both: true },
	])("rejects both or neither prompt source (batch=$batch, both=$both)", async ({ batch, both }) => {
		const taskFile = path.join(directory, "exclusive.md");
		await Bun.write(taskFile, "File task.");
		const item = { name: "Invalid", ...(both ? { task: "Inline task.", taskFile } : {}) };
		const tool = await createTool(batch);

		const result = await tool.execute("exclusive-file", batch ? { context: "Context.", tasks: [item] } : item);

		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/exactly one/i);
		expect(textOf(result)).toContain("taskFile");
		expect(executions).toHaveLength(0);
	});

	it("rejects a file over 4 MiB before dispatching any batch item or registering a job", async () => {
		const taskFile = path.join(directory, "oversize.md");
		await Bun.write(taskFile, new Uint8Array(4 * 1024 * 1024 + 1).fill(97));
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		const tool = await createTool(true, manager);

		const result = await tool.execute("oversize-file", {
			context: "Batch context.",
			tasks: [
				{ name: "Valid", task: "Must not start when another item is invalid." },
				{ name: "Oversize", taskFile },
			],
		});

		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/4 MiB|4194304/);
		expect(executions).toHaveLength(0);
		expect(manager.getJob("Valid")).toBeUndefined();
		expect(manager.getJob("Oversize")).toBeUndefined();
	});

	it("accepts a file of exactly 4 MiB", async () => {
		const taskFile = path.join(directory, "limit.md");
		const source = "a".repeat(4 * 1024 * 1024);
		await Bun.write(taskFile, source);
		const tool = await createTool();

		const result = await tool.execute("limit-file", { name: "Limit", taskFile });

		expect(result.isError).not.toBe(true);
		expect(result.details?.results[0]?.assignment).toBe(source);
	});

	it("rejects malformed UTF-8 instead of dispatching replacement characters", async () => {
		const taskFile = path.join(directory, "invalid-utf8.md");
		await Bun.write(taskFile, new Uint8Array([0x61, 0xc3, 0x28]));
		const tool = await createTool();

		const result = await tool.execute("invalid-utf8", { name: "InvalidUtf8", taskFile });

		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/UTF-8/i);
		expect(executions).toHaveLength(0);
	});

	it("rejects a directory as a non-regular file", async () => {
		const tool = await createTool();

		const result = await tool.execute("directory-file", { name: "Directory", taskFile: directory });

		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/regular file/i);
		expect(executions).toHaveLength(0);
	});

	it("rejects relative paths even when the file exists in the session directory", async () => {
		await Bun.write(path.join(directory, "relative.md"), "Relative task.");
		const tool = await createTool();

		const result = await tool.execute("relative-file", { name: "Relative", taskFile: "relative.md" });

		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/absolute/i);
		expect(executions).toHaveLength(0);
	});

	it("follows a symlink to a regular file and records the submitted symlink path", async () => {
		const target = path.join(directory, "target.md");
		const taskFile = path.join(directory, "symlink.md");
		const bytes = new TextEncoder().encode(" \nTask through a symlink.\n ");
		await Bun.write(target, bytes);
		await fs.symlink(target, taskFile);
		const tool = await createTool();

		const result = await tool.execute("symlink-file", { name: "Symlink", taskFile });

		expect(result.isError).not.toBe(true);
		expect(executions[0]?.assignment).toBe("Task through a symlink.");
		expect(result.details?.results[0]).toMatchObject({
			assignment: "Task through a symlink.",
			taskFile,
			taskFileSha256: await sha256(bytes),
		});
	});
});
