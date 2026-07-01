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

	// A KV-only structural fake of the host DO `Storage` binding. alchemy beta.59
	// colored the storage methods with `RuntimeContext` and added an options overload
	// this fake does not model, so the built object can't be assigned member-by-member;
	// it is widened ONCE through `unknown` (the widen-once idiom the makeD1Rest/sqlite-d1
	// fakes use), the same host-binding-fake case the repo discharges with `lint/plugin`.
	type Storage = LiveDoState["storage"];

	// biome-ignore lint/plugin: `Storage` is a host DO binding that can't be structurally constructed in a fake — beta.59's `RuntimeContext`-colored, overloaded signatures don't model in a plain KV Map; only the flat KV slice `makeLiveInstance` touches is exercised, nothing executes against the real binding.
	const storage = {
		get: <T>(key: string) => Effect.sync(() => kv.get(key) as T | undefined),
		put: <T>(key: string, value: T) =>
			Effect.sync(() => {
				kv.set(key, value);
			}),
		// MUST accept both a single key and an array (publish bulk-deletes rows).
		delete: (keyOrKeys: string | ReadonlyArray<string>) =>
			Effect.sync(() => {
				const keys = typeof keyOrKeys === "string" ? [keyOrKeys] : keyOrKeys;
				for (const key of keys) {
					kv.delete(key);
				}
			}),
		// A prefix-filtered COPY (not the live Map, so callers can't mutate the store).
		list: <T>({prefix}: {readonly prefix: string}) =>
			Effect.sync(() => {
				const out = new Map<string, T>();
				for (const [key, value] of kv) {
					if (key.startsWith(prefix)) {
						out.set(key, value as T);
					}
				}
				return out;
			}),
		getAlarm: () => Effect.sync(() => alarm),
		setAlarm: (scheduledTime: number) =>
			Effect.sync(() => {
				alarm = scheduledTime;
			}),
	} as unknown as Storage;

	const state: LiveDoState = {
		id: {toString: () => options?.id ?? "fake-do", name: options?.id} as LiveDoState["id"],
		storage,
	};

	return {
		state,
		hasAlarm: () => alarm !== null,
	};
}
