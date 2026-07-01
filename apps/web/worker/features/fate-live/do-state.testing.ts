/**
 * A node-pool platform fake of `Cloudflare.DurableObjectState["Service"]`,
 * KV-only — the slice {@link makeLiveInstance} touches. Backs the flat KV API
 * with one `Map` + a single alarm slot; `state.id.name` is the instance name
 * `resolveRole` reads. One non-obvious contract: `delete` MUST accept both a
 * single key and an array (publish bulk-deletes rows).
 *
 * A factory `*.testing.ts` module never imported by the worker graph
 * (`.patterns/effect-testing.md`).
 */
import * as Effect from "effect/Effect";
import type {LiveDoState} from "./live-do.ts";

export interface DurableObjectStateForTest {
	readonly state: LiveDoState;
	/** Whether an alarm is currently scheduled (tests assert on this). */
	readonly hasAlarm: () => boolean;
}

/** Build a test DO state with its own KV `Map` + single alarm slot. */
export function makeDurableObjectStateForTest(options?: {
	readonly id?: string;
}): DurableObjectStateForTest {
	const kv = new Map<string, unknown>();
	let alarm: number | null = null;

	// Each method is a generic `Effect` closure widened to its `Storage[...]` member
	// signature. alchemy beta.59 gave the DO storage methods `RuntimeContext` + an
	// options overload the KV-only fake does not model, so the cast widens through
	// `unknown` (the same widen-once idiom the makeD1Rest/sqlite-d1 fakes use).
	type Storage = LiveDoState["storage"];

	const storage: Storage = {
		get: (<T>(key: string) => Effect.sync(() => kv.get(key) as T | undefined)) as unknown as Storage["get"],
		put: (<T>(key: string, value: T) =>
			Effect.sync(() => {
				kv.set(key, value);
			})) as unknown as Storage["put"],
		// MUST accept both a single key and an array (publish bulk-deletes rows).
		delete: ((keyOrKeys: string | ReadonlyArray<string>) =>
			Effect.sync(() => {
				const keys = typeof keyOrKeys === "string" ? [keyOrKeys] : keyOrKeys;
				for (const key of keys) {
					kv.delete(key);
				}
			})) as unknown as Storage["delete"],
		// A prefix-filtered COPY (not the live Map, so callers can't mutate the store).
		list: (<T>({prefix}: {readonly prefix: string}) =>
			Effect.sync(() => {
				const out = new Map<string, T>();
				for (const [key, value] of kv) {
					if (key.startsWith(prefix)) {
						out.set(key, value as T);
					}
				}
				return out;
			})) as unknown as Storage["list"],
		getAlarm: (() => Effect.sync(() => alarm)) as unknown as Storage["getAlarm"],
		setAlarm: ((scheduledTime: number) =>
			Effect.sync(() => {
				alarm = scheduledTime;
			})) as unknown as Storage["setAlarm"],
	} as Storage;

	const state: LiveDoState = {
		id: {toString: () => options?.id ?? "fake-do", name: options?.id} as LiveDoState["id"],
		storage,
	};

	return {
		state,
		hasAlarm: () => alarm !== null,
	};
}
