import { logger } from "@oh-my-pi/pi-utils";

/**
 * Bind every prototype method declared on `basePrototype` onto `instance` so callers
 * that detach methods (e.g. `const { on } = pi` or `const emit = pi.events.emit`) keep
 * their receiver. Resolves each method on `instance`'s prototype chain so subclass
 * overrides take precedence over base implementations.
 */
export function bindPrototypeMethods<T extends object>(instance: T, basePrototype: object): void {
	for (const name of Object.getOwnPropertyNames(basePrototype)) {
		if (name === "constructor") continue;
		const baseDescriptor = Object.getOwnPropertyDescriptor(basePrototype, name);
		if (typeof baseDescriptor?.value !== "function") continue;
		const value = Reflect.get(instance, name, instance);
		if (typeof value !== "function") continue;
		Object.defineProperty(instance, name, {
			value: value.bind(instance),
			writable: true,
			configurable: true,
		});
	}
}

export class EventBus {
	readonly #listeners = new Map<string, Set<(data: unknown) => void>>();

	constructor() {
		// Upstream Pi's `createEventBus()` returns closure-backed methods, so extensions
		// (e.g. `pi-gemini-acp`) detach `pi.events.on` and `pi.events.emit`.
		bindPrototypeMethods(this, EventBus.prototype);
	}

	emit(channel: string, data: unknown): void {
		const handlers = this.#listeners.get(channel);
		if (handlers) {
			for (const handler of handlers) {
				handler(data);
			}
		}
	}

	on(channel: string, handler: (data: unknown) => void): () => void {
		if (!this.#listeners.has(channel)) {
			this.#listeners.set(channel, new Set());
		}
		const safeHandler = async (data: unknown) => {
			try {
				await handler(data);
			} catch (err) {
				logger.error("Event handler error", { channel, error: String(err) });
			}
		};
		this.#listeners.get(channel)!.add(safeHandler);
		return () => this.#listeners.get(channel)?.delete(safeHandler);
	}

	clear(): void {
		this.#listeners.clear();
	}
}

/**
 * Publishes a subagent frame on the session bus and the observability bus.
 * SDK embedders may pass the same EventBus for both slots; the identity check
 * skips the aliased re-emit so listeners never see duplicate frames.
 */
export function emitSubagentFrame(
	eventBus: EventBus | undefined,
	subagentEventBus: EventBus | undefined,
	channel: string,
	payload: unknown,
): void {
	eventBus?.emit(channel, payload);
	if (subagentEventBus && subagentEventBus !== eventBus) {
		subagentEventBus.emit(channel, payload);
	}
}
