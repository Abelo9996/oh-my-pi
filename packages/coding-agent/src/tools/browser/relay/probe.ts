/**
 * Client-side wait for the relay's extension handshake.
 *
 * `/json/version` answers 503 until the extension dials in, and the 503 body
 * ({@link RelayUnavailableInfo}) says whether an extension has ever done so.
 * That splits the two reasons for a 503 that used to look identical:
 * - Extension seen before: Chrome reaped its MV3 service worker; the
 *   extension's 30s keepalive alarm revives it, so waiting out one alarm
 *   period after the disconnect pays off. Past that, Chrome itself is gone
 *   (quit, profile closed) and the open fails at once.
 * - Extension never seen: an installed extension dials within one alarm
 *   period of the server starting, so once the server has been up that long
 *   nothing is coming and the open fails at once instead of burning the
 *   whole window every call.
 */
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { throwIfAborted } from "../../tool-errors";
import { probeCdpResponse } from "../attach";
import type { RelayUnavailableInfo } from "./server";
import { DISCARDED_TABS_PROTOCOL_VERSION } from "./protocol";

/**
 * One extension keepalive alarm period (30s, `background.js`) plus the dial
 * and hello. Both the reconnect wait and the "never connected" verdict use it.
 */
const EXTENSION_DIAL_WINDOW_MS = 35_000;
const PROBE_TIMEOUT_MS = 2_000;
const POLL_INTERVAL_MS = 150;

/** Outcome of {@link waitForRelayExtension}. */
export type RelayWaitOutcome =
	/** `/json/version` has the required relay and extension capabilities. */
	| "ready"
	/** Nothing (or something that is not a relay) is serving the endpoint. */
	| "unreachable"
	/** The relay is serving but no extension connected within the dial window. */
	| "no-extension"
	/** An extension connected earlier but has stayed away past the redial window (e.g. Chrome quit). */
	| "extension-gone"
	/** An older relay server is still running. */
	| "outdated-relay"
	/** A compatible relay from an older OMP is ready and reports no CDP client connected to it. */
	| "idle-older-relay"
	/** The relay extension is older than the running server. */
	| "outdated-extension";

/** The OMP version a parsed `/json/version` body (ready or waiting) reports; empty when it reports none. */
export function relayVersionOf(parsed: object): string {
	return "ompRelayVersion" in parsed && typeof parsed.ompRelayVersion === "string" ? parsed.ompRelayVersion : "";
}

/** CDP clients a parsed `/json/version` body (ready or waiting) reports; null for a relay too old to report them. */
export function relayCdpClientsOf(parsed: object): number | null {
	return "ompRelayCdpClients" in parsed && typeof parsed.ompRelayCdpClients === "number"
		? parsed.ompRelayCdpClients
		: null;
}

/** Whether a relay reporting `version` predates this OMP; one reporting none predates version markers. */
export function isOlderRelayVersion(version: string): boolean {
	if (version === "") return true;
	try {
		return Bun.semver.order(version, VERSION) < 0;
	} catch {
		// Unparseable: not provably older, so leave it to its owner.
		return false;
	}
}

function parseUnavailableInfo(body: string): Omit<RelayUnavailableInfo, "ompRelayCdpClients"> | null {
	try {
		const parsed: unknown = JSON.parse(body);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"extensionSeen" in parsed &&
			typeof parsed.extensionSeen === "boolean" &&
			"uptimeMs" in parsed &&
			typeof parsed.uptimeMs === "number"
		) {
			const disconnectedMs =
				"disconnectedMs" in parsed && typeof parsed.disconnectedMs === "number" ? parsed.disconnectedMs : undefined;
			return {
				error: "",
				extensionSeen: parsed.extensionSeen,
				uptimeMs: parsed.uptimeMs,
				ompRelayVersion: relayVersionOf(parsed),
				disconnectedMs,
			};
		}
	} catch {
		// Not a relay body (older relay or foreign server); treated as opaque 503 below.
	}
	return null;
}

function readyOutcome(body: string): RelayWaitOutcome {
	try {
		const parsed: unknown = JSON.parse(body);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			!("ompRelayDiscardedTabsProtocol" in parsed) ||
			parsed.ompRelayDiscardedTabsProtocol !== String(DISCARDED_TABS_PROTOCOL_VERSION)
		) {
			return "outdated-relay";
		}
		if (
			!("ompExtensionDiscardedTabsProtocol" in parsed) ||
			parsed.ompExtensionDiscardedTabsProtocol !== String(DISCARDED_TABS_PROTOCOL_VERSION)
		) {
			// A relay from another OMP version is the likelier culprit than the extension.
			if (relayVersionOf(parsed) !== VERSION) return "outdated-relay";
			return "outdated-extension";
		}
		if (isOlderRelayVersion(relayVersionOf(parsed)) && relayCdpClientsOf(parsed) === 0) return "idle-older-relay";
		return "ready";
	} catch {
		return "outdated-relay";
	}
}

/**
 * What the user must fix for a relay `outcome`, naming the command that fixes
 * it; null for outcomes an open proceeds past (`ready`, `idle-older-relay`).
 */
export function relayOutcomeMessage(outcome: RelayWaitOutcome, cdpUrl: string): string | null {
	switch (outcome) {
		case "ready":
		case "idle-older-relay":
			return null;
		case "unreachable":
			return `omp browser relay is not reachable at ${cdpUrl}. Start it with \`omp browser-relay\` (or check the endpoint), and make sure the OMP Browser Relay extension is loaded in Chrome.`;
		case "no-extension":
			return `omp browser relay is serving at ${cdpUrl} but its extension never connected. Install it with \`omp browser-relay install\` and check the toolbar badge shows "on".`;
		case "extension-gone":
			return `omp browser relay is serving at ${cdpUrl} but its extension disconnected and has not come back. Open Chrome with the OMP Browser Relay extension and check the toolbar badge shows "on".`;
		case "outdated-relay":
			return `The browser relay at ${cdpUrl} is out of date. Restart the relay under this OMP version, then retry.`;
		case "outdated-extension":
			return "The OMP Browser Relay extension is out of date. Run `omp browser-relay install` and reload the extension in Chrome.";
	}
}

/**
 * Probe the relay at `cdpUrl` once and classify it as
 * {@link waitForRelayExtension} would once its dial window closed. For an open
 * whose budget ran out mid-connect (relay auto-start or the extension wait),
 * so the timeout names what is missing instead of only the elapsed time.
 */
export async function probeRelayOutcome(cdpUrl: string, signal?: AbortSignal): Promise<RelayWaitOutcome> {
	const response = await probeCdpResponse(`${cdpUrl}/json/version`, { timeoutMs: PROBE_TIMEOUT_MS, signal });
	if (response === null) return "unreachable";
	if (response.status >= 200 && response.status < 300) return readyOutcome(response.body);
	if (response.status !== 503) return "unreachable";
	const info = parseUnavailableInfo(response.body);
	if (info !== null && info.ompRelayVersion !== VERSION) return "outdated-relay";
	return info?.disconnectedMs === undefined ? "no-extension" : "extension-gone";
}

/**
 * Poll the relay at `cdpUrl` until its extension is connected. Gives up
 * immediately when nothing serves the endpoint, once one dial window has
 * passed since a previously connected extension went away (service-worker
 * revival), or as soon as the server has been up a full dial window without
 * ever seeing one.
 */
export async function waitForRelayExtension(cdpUrl: string, signal?: AbortSignal): Promise<RelayWaitOutcome> {
	const probeUrl = `${cdpUrl}/json/version`;
	let deadline = Date.now() + EXTENSION_DIAL_WINDOW_MS;
	let staleRelay = false;
	for (;;) {
		throwIfAborted(signal);
		const response = await probeCdpResponse(probeUrl, { timeoutMs: PROBE_TIMEOUT_MS, signal });
		throwIfAborted(signal);
		if (response === null) return "unreachable";
		if (response.status >= 200 && response.status < 300) return readyOutcome(response.body);
		if (response.status !== 503) return "unreachable";
		const info = parseUnavailableInfo(response.body);
		// Past the dial window a relay from another version reads as outdated even
		// with CDP clients connected: no extension, so no browser, is behind them.
		staleRelay = info !== null && info.ompRelayVersion !== VERSION;
		if (info && !info.extensionSeen) {
			// Never connected: the window is measured from server start, not from now.
			deadline = Math.min(deadline, Date.now() - info.uptimeMs + EXTENSION_DIAL_WINDOW_MS);
		} else if (info?.disconnectedMs !== undefined) {
			// Seen, then gone: the redial window is measured from the disconnect.
			deadline = Math.min(deadline, Date.now() - info.disconnectedMs + EXTENSION_DIAL_WINDOW_MS);
			if (Date.now() >= deadline) return staleRelay ? "outdated-relay" : "extension-gone";
		}
		if (Date.now() >= deadline) return staleRelay ? "outdated-relay" : "no-extension";
		await Bun.sleep(POLL_INTERVAL_MS);
	}
}
