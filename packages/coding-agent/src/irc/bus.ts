/**
 * IrcBus - Process-global mailbox bus for agent-to-agent messaging.
 *
 * Replaces the old auto-reply model: a `send` never blocks on the recipient
 * generating anything. Delivery resolves the recipient via the global
 * AgentRegistry — parked and killed agents are revived through the
 * AgentLifecycleManager, idle agents are woken with a real turn, and busy
 * agents receive the message as a non-interrupting aside at the next step
 * boundary (see AgentSession.deliverIrcMessage).
 */

import { type IrcDeliveryReceipt, type IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { logger, Snowflake } from "@oh-my-pi/pi-utils";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import type { CustomMessage } from "../session/messages";

interface IrcWaiter {
	from?: string;
	resolve: (msg: IrcMessage) => void;
	cancel: () => void;
}

/** When a send went out: wall-clock `ts`, and `seq` to order sends within one millisecond. */
interface SendMark {
	ts: number;
	seq: number;
}

interface IrcRequest {
	id: string;
	to: string;
	sentAt: number;
}

interface IrcReply {
	from: string;
	to: string;
	/** Absent for an owned-job outcome, which answers all existing requests to that agent. */
	replyTo?: string;
}

/** Mailbox cap per agent; oldest messages are dropped beyond it. */
const MAILBOX_CAP = 100;

export class IrcBus {
	static #global: IrcBus | undefined;

	static global(): IrcBus {
		if (!IrcBus.#global) {
			IrcBus.#global = new IrcBus();
		}
		return IrcBus.#global;
	}

	/** Reset the global bus. Test-only. */
	static resetGlobalForTests(): void {
		const bus = IrcBus.#global;
		if (bus) bus.#unsubscribeRegistry();
		IrcBus.#global = undefined;
	}

	/**
	 * Count a settled job of agent `from` owned by `to` as `from`'s reply to
	 * `to`: the job delivers that agent's outcome, so it answers what `to`
	 * asked it before now (see {@link unansweredSends}). With no bus yet no
	 * message was ever sent, so there is nothing to answer.
	 */
	static recordReply(from: string, to: string): void {
		const bus = IrcBus.#global;
		if (bus) bus.#recordReply(from, to);
	}

	readonly #registry: AgentRegistry;
	readonly #lifecycle: () => AgentLifecycleManager;
	readonly #mailboxes = new Map<string, IrcMessage[]>();
	readonly #waiters = new Map<string, IrcWaiter[]>();
	/** The latest successful explicit send per `from` → `to`; see {@link sentSince}. */
	readonly #lastSent = new Map<string, Map<string, SendMark>>();
	/** Outstanding direct requests by sender and message identity. */
	readonly #requests = new Map<string, Map<string, IrcRequest>>();
	readonly #listeners = new Set<(reply?: IrcReply) => void>();
	readonly #unsubscribeRegistry: () => void;
	/** Last {@link SendMark.seq} handed out, taken when a send starts. */
	#sendSeq = 0;

	constructor(registry: AgentRegistry = AgentRegistry.global(), lifecycle?: AgentLifecycleManager) {
		this.#registry = registry;
		// Lazy: the lifecycle global self-constructs against the global registry,
		// so only touch it when a parked recipient actually needs reviving.
		this.#lifecycle = () => lifecycle ?? AgentLifecycleManager.global();
		this.#unsubscribeRegistry = registry.onChange(event => {
			if (event.type !== "removed" && event.ref.status !== "aborted") return;
			this.#requests.delete(event.ref.id);
			for (const [from, requests] of this.#requests) {
				for (const [id, request] of requests) {
					if (request.to === event.ref.id) requests.delete(id);
				}
				if (requests.size === 0) this.#requests.delete(from);
			}
			this.#emitChange();
		});
	}

	/**
	 * Fire-and-forget delivery. Never blocks on the recipient generating
	 * anything: the receipt reports how the message reached the recipient
	 * (waiter/aside = "injected", idle wake = "woken", park revival =
	 * "revived"), not what they did with it.
	 *
	 * Mailbox semantics: a successfully delivered message never lingers in
	 * the recipient's mailbox — injection/wake puts the full body into their
	 * context, so buffering it too would double-deliver via a later
	 * `wait`/`inbox` and inflate unread counts. Only a failed live hand-off
	 * is buffered for the recipient to drain later.
	 *
	 * `opts.suppressRelay` skips the display-only main-UI relay for this leg.
	 * Set by broadcast fan-out when the same broadcast also targets the main
	 * agent directly: the main agent then already sees the body as its own
	 * incoming card, so relaying the sibling legs would duplicate it.
	 */
	async send(msg: Omit<IrcMessage, "id" | "ts">, opts?: { suppressRelay?: boolean }): Promise<IrcDeliveryReceipt> {
		const message: IrcMessage = { ...msg, id: Snowflake.next(), ts: Date.now() };
		// Taken before delivery: a reply sent while this message is still being
		// delivered must still order after it.
		const mark: SendMark = { ts: message.ts, seq: ++this.#sendSeq };
		// Register before handing off: a wake can answer, or settle its owned
		// job, before delivery itself returns. Never reinsert that request.
		let isRequest = !message.broadcast && !message.wakeRelay && !message.replyTo;
		const requestsFromRecipient = this.#requests.get(message.to);
		if (isRequest && requestsFromRecipient) {
			// A message back while the sender owes this recipient an answer is
			// progress on that request, not a new reverse reply obligation.
			const since = this.#registry.get(message.to)?.session?.runStartedAt ?? 0;
			for (const request of requestsFromRecipient.values()) {
				if (request.to === message.from && request.sentAt >= since) {
					isRequest = false;
					break;
				}
			}
		}
		if (isRequest) {
			let requests = this.#requests.get(message.from);
			if (!requests) {
				requests = new Map();
				this.#requests.set(message.from, requests);
			}
			requests.set(message.id, { id: message.id, to: message.to, sentAt: message.ts });
		}
		const receipt = await this.#deliver(message, opts);
		if (receipt.outcome !== "failed") {
			if (!message.wakeRelay) this.#record(this.#lastSent, message.from, message.to, mark);
			if (message.replyTo && !message.broadcast) this.#recordReply(message.from, message.to, message.replyTo);
		} else if (isRequest) {
			const requests = this.#requests.get(message.from);
			requests?.delete(message.id);
			if (requests?.size === 0) this.#requests.delete(message.from);
			this.#emitChange();
		}
		return receipt;
	}

	#record(table: Map<string, Map<string, SendMark>>, from: string, to: string, mark: SendMark): void {
		let sent = table.get(from);
		if (!sent) {
			sent = new Map();
			table.set(from, sent);
		}
		// Deliveries can settle out of order; keep the latest send.
		if ((sent.get(to)?.seq ?? 0) < mark.seq) sent.set(to, mark);
	}

	#recordReply(from: string, to: string, replyTo?: string): void {
		const requests = this.#requests.get(to);
		if (requests) {
			for (const [id, request] of requests) {
				if (request.to === from && (replyTo === undefined || id === replyTo)) requests.delete(id);
			}
			if (requests.size === 0) this.#requests.delete(to);
		}
		this.#emitChange({ from, to, replyTo });
	}

	#emitChange(reply?: IrcReply): void {
		for (const listener of this.#listeners) {
			try {
				listener(reply);
			} catch {
				// Observers must not break message or job delivery.
			}
		}
	}

	/** Observe settled requests; successful replies carry their correlation for wake-turn deduplication. */
	onChange(listener: (reply?: IrcReply) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/**
	 * Whether `from` successfully sent `to` an explicit message at or after
	 * `sinceTs`. Automatic wake relays do not count as explicit messages.
	 * Wake-turn summaries use it to distinguish message-only output from no
	 * output and to avoid treating a post-progress relay as a final answer.
	 */
	sentSince(from: string, to: string, sinceTs: number): boolean {
		const sent = this.#lastSent.get(from)?.get(to);
		return sent !== undefined && sent.ts >= sinceTs;
	}

	/**
	 * Direct requests sent at or after `sinceTs` still owed to `from`.
	 * Only a reply naming that message from its recipient, or that agent's
	 * owned-job outcome, settles it. Ordinary acknowledgements do not.
	 * Idle/wake transitions retain requests; cancellation or unavailability
	 * removes them. Message identity distinguishes same-millisecond requests.
	 */
	unansweredSends(from: string, sinceTs: number): IrcRequest[] {
		const requests = this.#requests.get(from);
		if (!requests) return [];
		const unanswered: IrcRequest[] = [];
		for (const [id, request] of requests) {
			if (request.sentAt < sinceTs) {
				requests.delete(id);
				continue;
			}
			const ref = this.#registry.get(request.to);
			if (
				!ref ||
				ref.kind === "advisor" ||
				ref.status === "aborted" ||
				(!ref.session && (ref.status !== "parked" || !ref.sessionFile))
			) {
				requests.delete(id);
				continue;
			}
			unanswered.push(request);
		}
		if (requests.size === 0) this.#requests.delete(from);
		return unanswered;
	}

	async #deliver(message: IrcMessage, opts?: { suppressRelay?: boolean }): Promise<IrcDeliveryReceipt> {
		const ref = this.#registry.get(message.to);
		if (!ref) {
			return {
				to: message.to,
				outcome: "failed",
				error: `Unknown agent "${message.to}" — check the subagent roster or read history:// for known peers.`,
			};
		}
		// Advisor refs are observability-only transcripts, never messageable peers.
		if (ref.kind === "advisor") {
			return {
				to: message.to,
				outcome: "failed",
				error: `Agent "${message.to}" is a read-only advisor transcript and cannot be messaged.`,
			};
		}

		// A `parked` or killed (`aborted`) recipient always needs the lifecycle to
		// revive it from its transcript — this is read from *this* bus's registry,
		// so it holds for any registry. The mid-park / adopted checks below query
		// the lifecycle's own state, which only describes the registry it manages:
		// consult them only when the lifecycle owns this bus's registry, otherwise
		// a custom-registry bus (fallen back to the global manager) would gate a
		// live recipient on unrelated global park state. Main/non-adopted live
		// peers skip the gate, and pending waiters still win without a session.
		const lifecycle = this.#lifecycle();
		const lifecycleOwnsRegistry = lifecycle.manages(this.#registry);
		const needsLifecycleGate =
			ref.status === "parked" ||
			ref.status === "aborted" ||
			(lifecycleOwnsRegistry && (lifecycle.isParking(message.to) || lifecycle.has(message.to)));

		const priorSession = ref.session;
		let revived = false;
		if (needsLifecycleGate) {
			try {
				const liveSession = await lifecycle.ensureLive(message.to);
				// Revival = we did not keep the same live instance (parked start, or
				// park completed and a fresh session was rebuilt).
				revived = !priorSession || liveSession !== priorSession;
			} catch (error) {
				// Not revivable / released / revive failed. Do not buffer: a permanent
				// failure must not inflate unread counts or pretend delivery is pending.
				return {
					to: message.to,
					outcome: "failed",
					error: error instanceof Error ? error.message : String(error),
				};
			}
		}

		// A pending `wait` from the recipient consumes the message directly —
		// it is returned from their irc tool call and never hits the inbox or
		// the session injection path.
		const waiter = this.#takeMatchingWaiter(message.to, message.from);
		if (waiter) {
			waiter.resolve(message);
			if (!opts?.suppressRelay) this.#relayToMainUi(message);
			return { to: message.to, outcome: revived ? "revived" : "injected" };
		}

		const session = this.#registry.get(message.to)?.session;
		if (!session) {
			return { to: message.to, outcome: "failed", error: `Agent "${message.to}" has no live session.` };
		}

		try {
			const delivery = await session.deliverIrcMessage(message);
			if (!opts?.suppressRelay) this.#relayToMainUi(message);
			return { to: message.to, outcome: revived ? "revived" : delivery };
		} catch (error) {
			// Live hand-off failed (e.g. recipient disposed mid-shutdown): buffer
			// the message so a later `wait`/`inbox` from the recipient can still
			// pick it up. The receipt stays "failed" — the recipient has not
			// seen it.
			this.#enqueue(message);
			return {
				to: message.to,
				outcome: "failed",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	/**
	 * Block until a message for `agentId` (optionally from `filter.from`)
	 * arrives; consume + return it. Null on timeout (`timeoutMs <= 0` waits
	 * forever). Rejects when `signal` aborts. By default, already-buffered
	 * mail satisfies the wait before parking a future waiter; callers that
	 * need a strictly future reply can disable that drain.
	 */
	async wait(
		agentId: string,
		filter: { from?: string },
		timeoutMs: number,
		signal?: AbortSignal,
		options?: { drainPending?: boolean },
	): Promise<IrcMessage | null> {
		if (signal?.aborted) {
			throw signal.reason instanceof Error ? signal.reason : new Error("IRC wait aborted");
		}

		if (options?.drainPending !== false) {
			// Already-pending mail satisfies the wait without parking a waiter.
			const pending = this.#takeFromMailbox(agentId, filter.from);
			if (pending) return pending;
		}

		const { promise, resolve, reject } = Promise.withResolvers<IrcMessage | null>();
		let timer: NodeJS.Timeout | undefined;
		let onAbort: (() => void) | undefined;

		const settle = (
			outcome: { kind: "message"; msg: IrcMessage } | { kind: "timeout" } | { kind: "abort"; error: Error },
		): void => {
			cleanup();
			if (outcome.kind === "message") {
				resolve(outcome.msg);
			} else if (outcome.kind === "timeout") {
				resolve(null);
			} else {
				reject(outcome.error);
			}
		};

		const cleanup = (): void => {
			this.#removeWaiter(agentId, waiter);
			clearTimeout(timer);
			if (signal && onAbort) signal.removeEventListener("abort", onAbort);
		};

		const waiter: IrcWaiter = {
			from: filter.from,
			resolve: msg => settle({ kind: "message", msg }),
			cancel: () => cleanup(),
		};

		if (signal) {
			onAbort = () =>
				settle({
					kind: "abort",
					error: signal.reason instanceof Error ? signal.reason : new Error("IRC wait aborted"),
				});
			signal.addEventListener("abort", onAbort, { once: true });
		}
		if (timeoutMs > 0) {
			timer = setTimeout(() => settle({ kind: "timeout" }), timeoutMs);
			timer.unref?.();
		}

		let waiters = this.#waiters.get(agentId);
		if (!waiters) {
			waiters = [];
			this.#waiters.set(agentId, waiters);
		}
		waiters.push(waiter);

		return promise;
	}

	/**
	 * Consume the OLDEST pending message for `agentId` (optionally restricted
	 * to `from`), leaving the rest of the mailbox intact. This is the exact
	 * atomic step `wait` performs on entry, exposed for callers that must not
	 * block without draining the entire backlog.
	 */
	take(agentId: string, from?: string): IrcMessage | undefined {
		return this.#takeFromMailbox(agentId, from);
	}

	/** Unread count for the local Agent Hub overlay. */
	unreadCount(agentId: string): number {
		return this.#mailboxes.get(agentId)?.length ?? 0;
	}

	#enqueue(message: IrcMessage): void {
		let mailbox = this.#mailboxes.get(message.to);
		if (!mailbox) {
			mailbox = [];
			this.#mailboxes.set(message.to, mailbox);
		}
		mailbox.push(message);
		if (mailbox.length > MAILBOX_CAP) {
			const dropped = mailbox.shift();
			logger.debug("IrcBus: mailbox full, dropped oldest message", {
				agentId: message.to,
				droppedId: dropped?.id,
				droppedFrom: dropped?.from,
			});
		}
	}

	/** Resolve the OLDEST waiter for `agentId` whose from-filter accepts `from`. */
	#takeMatchingWaiter(agentId: string, from: string): IrcWaiter | undefined {
		const waiters = this.#waiters.get(agentId);
		if (!waiters) return undefined;
		const index = waiters.findIndex(waiter => !waiter.from || waiter.from === from);
		if (index === -1) return undefined;
		const [waiter] = waiters.splice(index, 1);
		if (waiters.length === 0) this.#waiters.delete(agentId);
		return waiter;
	}

	#removeWaiter(agentId: string, waiter: IrcWaiter): void {
		const waiters = this.#waiters.get(agentId);
		if (!waiters) return;
		const index = waiters.indexOf(waiter);
		if (index !== -1) waiters.splice(index, 1);
		if (waiters.length === 0) this.#waiters.delete(agentId);
	}

	#takeFromMailbox(agentId: string, from?: string): IrcMessage | undefined {
		const mailbox = this.#mailboxes.get(agentId);
		if (!mailbox) return undefined;
		const index = from ? mailbox.findIndex(msg => msg.from === from) : 0;
		if (index === -1 || mailbox.length === 0) return undefined;
		const [message] = mailbox.splice(index, 1);
		if (mailbox.length === 0) this.#mailboxes.delete(agentId);
		if (message?.replyTo && !message.broadcast) this.#recordReply(message.from, message.to, message.replyTo);
		return message;
	}

	/**
	 * Surface agent↔agent traffic as a display-only card on the main session
	 * UI. Skipped when the main agent is either endpoint: as recipient its
	 * own `deliverIrcMessage` (or `wait` tool result) already shows the
	 * message, and as sender the irc send tool call already rendered the
	 * outbound body — relaying it again would duplicate it in the transcript.
	 */
	#relayToMainUi(message: IrcMessage): void {
		if (message.to === MAIN_AGENT_ID || message.from === MAIN_AGENT_ID) return;
		const mainSession = this.#registry.get(MAIN_AGENT_ID)?.session;
		if (!mainSession) return;
		const record: CustomMessage = {
			role: "custom",
			customType: "irc:relay",
			content: `[IRC \`${message.from}\` → \`${message.to}\`]\n\n${message.body}`,
			display: true,
			details: { from: message.from, to: message.to, body: message.body },
			attribution: "agent",
			timestamp: message.ts,
		};
		try {
			mainSession.emitIrcRelayObservation(record);
		} catch (error) {
			// Display-only forwarding must never affect delivery semantics.
			logger.debug("IrcBus: main UI relay failed", { to: message.to, error: String(error) });
		}
	}
}
