/**
 * Thread-notice progress events reach an RPC host: model fallback (`retry_fallback_applied`),
 * goal changes (`goal_updated`), rule injection (`ttsr_triggered`), and manual compaction
 * (`manual_compaction_start`/`manual_compaction_end`). Drives a real SDK session in
 * `runRpcMode` over the RPC client; only the model is scripted
 * (`fixtures/progress-events-rpc-agent.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const FIXTURE = path.join(import.meta.dir, "fixtures", "progress-events-rpc-agent.ts");

let client: RpcClient | undefined;
let directory: string | undefined;

afterEach(async () => {
	await client?.stop();
	client = undefined;
	if (directory) await removeWithRetries(directory);
	directory = undefined;
});

/** Start the fixture and record every session event frame it writes. */
async function start(): Promise<{ rpc: RpcClient; events: AgentSessionEvent[] }> {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-progress-"));
	client = new RpcClient({
		command: [process.execPath, FIXTURE],
		cwd: directory,
		env: { PI_CODING_AGENT_DIR: directory, PI_NO_TITLE: "1" },
	});
	const events: AgentSessionEvent[] = [];
	client.onSessionEvent(event => events.push(event));
	await client.start();
	return { rpc: client, events };
}

function ofType<T extends AgentSessionEvent["type"]>(
	events: readonly AgentSessionEvent[],
	type: T,
): Extract<AgentSessionEvent, { type: T }>[] {
	return events.filter((event): event is Extract<AgentSessionEvent, { type: T }> => event.type === type);
}

describe("RPC progress events", () => {
	test("retry_fallback_applied reports the model switch", async () => {
		const { rpc, events } = await start();
		await rpc.promptAndWait("trigger fallback");

		expect(ofType(events, "retry_fallback_applied")).toEqual([
			{
				type: "retry_fallback_applied",
				// The selector carries the session's thinking level suffix (`:high`).
				from: expect.stringMatching(/^anthropic\/claude-sonnet-4-5(:|$)/),
				to: "openai/gpt-4o-mini",
				role: "default",
				reason: expect.stringContaining("overloaded_error"),
			},
		]);
		expect(ofType(events, "retry_fallback_succeeded")).toEqual([
			{ type: "retry_fallback_succeeded", model: "openai/gpt-4o-mini", role: "default" },
		]);
		expect(await rpc.getLastAssistantText()).toBe("recovered on the fallback model");
	}, 60_000);

	test("goal_updated reports goal changes", async () => {
		const { rpc, events } = await start();
		await rpc.goal("create", { objective: "ship the progress events" });
		await rpc.goal("pause");

		const updates = ofType(events, "goal_updated");
		expect(updates.map(update => [update.goal?.objective, update.goal?.status])).toEqual([
			["ship the progress events", "active"],
			["ship the progress events", "paused"],
		]);
	}, 60_000);

	test("ttsr_triggered reports rule injection with the rule's name, path, and content", async () => {
		const { rpc, events } = await start();
		await rpc.promptAndWait("say the rule phrase");
		await rpc.waitForSettled();

		const injections = ofType(events, "ttsr_triggered");
		expect(injections).toHaveLength(1);
		expect(injections[0].rules).toMatchObject([
			{ name: "no-forbidden", path: expect.stringContaining("no-forbidden.md"), content: expect.any(String) },
		]);
	}, 60_000);

	test("manual compact emits manual_compaction_start and manual_compaction_end", async () => {
		const { rpc, events } = await start();
		await rpc.promptAndWait("first turn");
		await rpc.promptAndWait("second turn");

		const committed = await rpc.compact();
		expect(committed.summary).toBe("compacted by the test hook");
		const pair = events.filter(event => event.type.startsWith("manual_compaction_"));
		expect(pair).toEqual([
			{ type: "manual_compaction_start" },
			{ type: "manual_compaction_end", aborted: false, result: committed },
		]);
		// Automatic compaction keeps its own pair; a manual one never reports through it.
		expect(events.some(event => event.type.startsWith("auto_compaction_"))).toBe(false);

		// Nothing left to compact: the command fails and the pair still closes, as skipped.
		events.length = 0;
		await expect(rpc.compact()).rejects.toThrow("Already compacted");
		expect(events.filter(event => event.type.startsWith("manual_compaction_"))).toEqual([
			{ type: "manual_compaction_start" },
			{ type: "manual_compaction_end", aborted: false, skipped: true, errorMessage: "Already compacted" },
		]);
	}, 60_000);
});
