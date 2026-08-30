export type RuntimeState =
	| {readonly _tag: "loading"}
	| {readonly _tag: "ready"}
	| {readonly _tag: "refused"; readonly reason: string};

export interface RuntimeLifecycle {
	readonly sessionId: string;
	readonly attempt: number;
	readonly state: RuntimeState;
}

export interface RuntimeLifecycleSource {
	currentRuntime: (sessionId: string) => RuntimeLifecycle | undefined;
	subscribeRuntime: (listener: (event: RuntimeLifecycle) => void) => () => void;
}

export type HistoryState =
	| {readonly _tag: "loading"}
	| {readonly _tag: "ready"}
	| {readonly _tag: "refused"; readonly reason: string};

export interface HistoryLifecycle {
	readonly sessionId: string;
	readonly attempt: number;
	readonly state: HistoryState;
}

export interface HistoryLifecycleSource {
	currentHistory: (sessionId: string) => HistoryLifecycle | undefined;
	subscribeHistory: (listener: (event: HistoryLifecycle) => void) => () => void;
}

export class RuntimeOwnership implements RuntimeLifecycleSource {
	readonly #owners = new Map<string, string>();
	readonly #lifecycles = new Map<string, RuntimeLifecycle>();
	readonly #listeners = new Set<(event: RuntimeLifecycle) => void>();
	#nextAttempt = 0;

	ownerOf(sessionId: string): string | undefined {
		return this.#owners.get(sessionId);
	}

	begin(sessionId: string, ownerId: string): RuntimeLifecycle {
		const lifecycle: RuntimeLifecycle = {
			sessionId,
			attempt: ++this.#nextAttempt,
			state: {_tag: "loading"},
		};
		this.#owners.set(sessionId, ownerId);
		this.#publish(lifecycle);
		return lifecycle;
	}

	adoptReady(sessionId: string, ownerId: string): RuntimeLifecycle {
		const lifecycle: RuntimeLifecycle = {
			sessionId,
			attempt: ++this.#nextAttempt,
			state: {_tag: "ready"},
		};
		this.#owners.set(sessionId, ownerId);
		this.#publish(lifecycle);
		return lifecycle;
	}

	isLoading(lifecycle: RuntimeLifecycle, ownerId: string): boolean {
		return (
			lifecycle.state._tag === "loading" &&
			this.#owners.get(lifecycle.sessionId) === ownerId &&
			this.#lifecycles.get(lifecycle.sessionId) === lifecycle
		);
	}

	ready(lifecycle: RuntimeLifecycle, ownerId: string): boolean {
		if (!this.isLoading(lifecycle, ownerId)) return false;
		this.#publish({...lifecycle, state: {_tag: "ready"}});
		return true;
	}

	refuse(lifecycle: RuntimeLifecycle, ownerId: string, reason: string): boolean {
		if (!this.isLoading(lifecycle, ownerId)) return false;
		this.#owners.delete(lifecycle.sessionId);
		this.#publish({...lifecycle, state: {_tag: "refused", reason}});
		return true;
	}

	release(sessionId: string, ownerId: string): boolean {
		if (this.#owners.get(sessionId) !== ownerId) return false;
		this.#owners.delete(sessionId);
		return true;
	}

	currentRuntime = (sessionId: string): RuntimeLifecycle | undefined =>
		this.#lifecycles.get(sessionId);

	subscribeRuntime = (listener: (event: RuntimeLifecycle) => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	#publish(lifecycle: RuntimeLifecycle): void {
		this.#lifecycles.set(lifecycle.sessionId, lifecycle);
		for (const listener of this.#listeners) listener(lifecycle);
	}
}

export class HistoryLifecycleStore implements HistoryLifecycleSource {
	readonly #lifecycles = new Map<string, HistoryLifecycle>();
	readonly #listeners = new Set<(event: HistoryLifecycle) => void>();
	#nextAttempt = 0;

	begin(sessionId: string): HistoryLifecycle {
		const lifecycle: HistoryLifecycle = {
			sessionId,
			attempt: ++this.#nextAttempt,
			state: {_tag: "loading"},
		};
		this.#publish(lifecycle);
		return lifecycle;
	}

	ready(lifecycle: HistoryLifecycle): boolean {
		if (this.#lifecycles.get(lifecycle.sessionId) !== lifecycle) return false;
		this.#publish({...lifecycle, state: {_tag: "ready"}});
		return true;
	}

	refuse(lifecycle: HistoryLifecycle, reason: string): boolean {
		if (this.#lifecycles.get(lifecycle.sessionId) !== lifecycle) return false;
		this.#publish({...lifecycle, state: {_tag: "refused", reason}});
		return true;
	}

	currentHistory = (sessionId: string): HistoryLifecycle | undefined =>
		this.#lifecycles.get(sessionId);

	subscribeHistory = (listener: (event: HistoryLifecycle) => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	#publish(lifecycle: HistoryLifecycle): void {
		this.#lifecycles.set(lifecycle.sessionId, lifecycle);
		for (const listener of this.#listeners) listener(lifecycle);
	}
}
