/**
 * Title drift detection: asks one yes/no judge question whether a session's
 * generated title still names its recent conversation, so a
 * `title.refreshAfterPrompts` check regenerates only a title the session has
 * moved away from. The judge comes from the live `judge` role chain resolved by
 * {@link resolveJudge}.
 */
import type { AgentTelemetryConfig } from "@oh-my-pi/pi-agent-core";
import { judgeQuestions, type Model } from "@oh-my-pi/pi-ai";
import { redactSensitiveCredentials } from "@oh-my-pi/pi-ai/providers/transform-messages";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { type JudgmentUsage, resolveJudge, sharedJudgmentCache } from "../judgment";
import questionFile from "../prompts/judge/title-drift.json" with { type: "json" };
import { splitCardTitle } from "../utils/title-card";
import type { CostGate } from "./cost-gate";
import type { TitleDriftTurn } from "./messages";

/**
 * Yes-probability below which a title no longer fits its conversation. Tuned on
 * 205 title and conversation checkpoints from real sessions, labeled fits or
 * stale by a larger chat model: `typesafe/jev-1.14.0` separated them with ROC
 * AUC 0.95, and below 0.5, 89% of the titles it flagged were stale and it caught
 * 74% of stale titles (100% and 87% on confidently labeled checkpoints). Higher
 * cutoffs caught more stale titles but flagged fitting ones. Keyword judges
 * answer exactly 0 or 1.
 */
const TITLE_FITS_THRESHOLD = 0.5;

/** The yes/no `fits` question; criteria stay bulleted examples, as for the other judge questions. */
const QUESTIONS = judgeQuestions(questionFile);

/** A session title and the recent conversation it should name. */
export interface TitleDriftCheck {
	/** The session title, card included; the judge reads only its text. */
	title: string;
	/** Latest turns, oldest first (see `buildTitleDriftTurns`). */
	recent: TitleDriftTurn[];
}

export interface ClassifyTitleDriftDeps {
	settings: Settings;
	registry: ModelRegistry;
	sessionId: string;
	/** Active session model; last resort of the judge role chain. */
	model?: Model;
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined;
	/** Session ledger for the classification's billed attempts. */
	onUsage?: (usage: JudgmentUsage) => void;
	telemetry?: AgentTelemetryConfig;
	/** The session tree's cost gate: a capped session sends no judgment. */
	costGate?: CostGate;
	signal?: AbortSignal;
}

/** `true` when the title no longer fits the recent conversation, `false` when it does, `undefined` when no judge could answer. */
export async function classifyTitleDrift(
	check: TitleDriftCheck,
	deps: ClassifyTitleDriftDeps,
): Promise<boolean | undefined> {
	try {
		const judge = resolveJudge({
			settings: deps.settings,
			registry: deps.registry,
			sessionModel: deps.model,
			sessionId: deps.sessionId,
			metadataResolver: deps.metadataResolver,
			purpose: "title-drift",
			onUsage: deps.onUsage,
			telemetry: deps.telemetry,
			cache: sharedJudgmentCache(),
			costGate: deps.costGate,
		});
		// Native judges send `state` verbatim, past the message transforms that redact chat requests, so
		// credentials are redacted here under the caller's `withCredentialRedaction` scope.
		const title = redactSensitiveCredentials(splitCardTitle(check.title)?.title ?? check.title);
		const recent = check.recent.map(turn => ({ role: turn.role, text: redactSensitiveCredentials(turn.text) }));
		const { answers } = await judge.judge(
			{ state: { title, recent }, questions: { fits: QUESTIONS.fits } },
			{ signal: deps.signal },
		);
		return answers.fits.noul < TITLE_FITS_THRESHOLD;
	} catch (error) {
		logger.debug("title-drift: classification failed", {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}
