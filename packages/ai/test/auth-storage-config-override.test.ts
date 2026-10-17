import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { removeWithRetries } from "../../utils/src/temp";
import { withEnv } from "./helpers";

const SUPPRESS_ANTHROPIC_ENV = {
	ANTHROPIC_API_KEY: undefined,
	ANTHROPIC_OAUTH_TOKEN: undefined,
} as const;

describe("AuthStorage config-override apiKey", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-config-override-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store, {
			usageProviderResolver: () => undefined,
			configValueResolver: async value => (value.startsWith("!") ? undefined : value),
		});
	});

	afterEach(async () => {
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	async function seedOAuth(provider: string, access: string): Promise<void> {
		if (!authStorage) throw new Error("test setup failed");
		await authStorage.credentials.set(provider, [
			{
				type: "oauth",
				access,
				refresh: `${access}-refresh`,
				expires: Date.now() + 60 * 60_000,
			},
		]);
	}

	test("setConfigApiKey beats OAuth access token for getApiKey", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			await seedOAuth("anthropic", "oauth-from-broker");
			authStorage.keys.setConfig("anthropic", "gateway-bearer");

			expect(await authStorage.keys.get("anthropic")).toBe("gateway-bearer");
			expect(await authStorage.keys.peek("anthropic")).toBe("gateway-bearer");
		});
	});

	test("runtime override (--api-key) still beats setConfigApiKey", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			await seedOAuth("anthropic", "oauth-from-broker");
			authStorage.keys.setConfig("anthropic", "gateway-bearer");
			authStorage.keys.setRuntime("anthropic", "cli-flag-bearer");

			expect(await authStorage.keys.get("anthropic")).toBe("cli-flag-bearer");
		});
	});

	test("removeConfigApiKey restores OAuth resolution", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			await seedOAuth("anthropic", "oauth-from-broker");
			authStorage.keys.setConfig("anthropic", "gateway-bearer");
			expect(await authStorage.keys.get("anthropic")).toBe("gateway-bearer");

			authStorage.keys.removeConfig("anthropic");
			expect(await authStorage.keys.get("anthropic")).toBe("oauth-from-broker");
		});
	});

	test("clearConfigApiKeys drops every config override at once", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			await seedOAuth("anthropic", "oauth-anthropic");
			await seedOAuth("openai-codex", "oauth-codex");
			authStorage.keys.setConfig("anthropic", "gateway-bearer-A");
			authStorage.keys.setConfig("openai-codex", "gateway-bearer-B");

			authStorage.keys.clearConfig();

			expect(await authStorage.keys.get("anthropic")).toBe("oauth-anthropic");
			expect(await authStorage.keys.get("openai-codex")).toBe("oauth-codex");
		});
	});

	test("setConfigApiKey suppresses OAuth account_uuid attribution", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			await authStorage.credentials.set("anthropic", [
				{
					type: "oauth",
					access: "oauth-with-account",
					refresh: "r",
					expires: Date.now() + 60 * 60_000,
					accountId: "acc-123",
				},
			]);
			// Sanity: without override, accountId is exposed.
			expect(authStorage.oauth.identity("anthropic")?.accountId).toBe("acc-123");

			authStorage.keys.setConfig("anthropic", "gateway-bearer");
			// With an explicit config bearer in play, OAuth account attribution
			// must NOT leak — outbound auth is the gateway bearer, not OAuth.
			expect(authStorage.oauth.identity("anthropic")?.accountId).toBeUndefined();
		});
	});

	test("describeCredentialSource reports config override", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			await seedOAuth("anthropic", "oauth-from-broker");
			authStorage.keys.setConfig("anthropic", "gateway-bearer");
			expect(authStorage.keys.describe("anthropic")).toBe("config override (models.yml)");
		});
	});

	test("usage probes only the configured account when a stale login key is stored", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const provider = "configured-usage";
		const probedKeys: string[] = [];
		await authStorage.credentials.set(provider, { type: "api_key", key: "sk-stale", source: "login" });
		authStorage.keys.setConfig(provider, "sk-configured");
		authStorage.usage.setProvider(provider, {
			id: provider,
			async fetchUsage({ credential }) {
				probedKeys.push(credential.apiKey ?? "");
				if (credential.apiKey !== "sk-configured") return null;
				return {
					provider,
					fetchedAt: Date.now(),
					limits: [
						{
							id: "quota",
							label: "Quota",
							scope: { provider },
							amount: { usedFraction: 0.4, unit: "percent" },
						},
					],
				};
			},
		});

		const reports = await authStorage.usage.reports();
		expect(
			reports?.filter(report => report.provider === provider).map(report => report.limits[0]?.amount.usedFraction),
		).toEqual([0.4]);
		expect(probedKeys).toEqual(["sk-configured"]);
	});

	test("an unresolved configured key cannot expose an ambient provider key to usage", async () => {
		await withEnv({ OPENAI_API_KEY: "sk-ambient" }, async () => {
			if (!authStorage) throw new Error("test setup failed");
			const provider = "openai";
			const probedKeys: string[] = [];
			authStorage.keys.setConfig(provider, "!failed-command");
			authStorage.usage.setProvider(provider, {
				id: provider,
				async fetchUsage({ credential }) {
					probedKeys.push(credential.apiKey ?? "");
					return { provider, fetchedAt: Date.now(), limits: [] };
				},
			});

			expect(await authStorage.keys.get(provider)).toBeUndefined();
			expect((await authStorage.usage.reports())?.some(report => report.provider === provider)).toBe(false);
			expect(probedKeys).toEqual([]);
		});
	});
});
