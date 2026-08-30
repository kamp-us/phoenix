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
