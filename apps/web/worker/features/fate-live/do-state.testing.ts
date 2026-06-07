/**
 * A node-pool fake of alchemy's `Cloudflare.DurableObjectState["Service"]` value,
 * KV-only — the slice the unified {@link makeLiveInstance} touches.
 *
 * The void-aligned `LiveDO` stores everything in `state.storage`'s flat KV API
 * (no SQLite): subscriber rows under `sub:` keys, the per-connection generation
 * scalar, plus a single-slot alarm. So this fake backs the lot with one
 * `Map<string, unknown>` + a `number | null` alarm slot and implements exactly
 * the `state.storage` methods the instance builder calls:
 *
 *   - `get<T>(key)` → `Effect<T | undefined>`
 *   - `put(key, value)` → `Effect<void>`
 *   - `delete(key | key[])` → `Effect<void>` (publish bulk-deletes an array)
 *   - `list<T>({prefix})` → `Effect<Map<string, T>>` (prefix-filtered copy)
 *   - `getAlarm()` → `Effect<number | null>` / `setAlarm(ms)` → `Effect<void>`
 *
 * `state.id.name` is the instance name `resolveRole` reads to pick the
 * connection/topic role. Pass `kv`/alarm-sharing options are unneeded here — each
 * call is one instance over its own backing Map.
 *
 * A **platform fake** ({@link makeDurableObjectStateForTest}, a `makeXxxForTest`
 * factory over the raw `DurableObjectState` platform type) — NOT a production
 * artifact: it's a colocated `*.testing.ts` module never imported by the worker
 * graph, and a factory, not a shared instance (`.patterns/effect-testing.md`).
 */
import * as Effect from "effect/Effect";
import type {LiveDoState} from "./live-do.ts";

export interface DurableObjectStateForTest {
	/** The `DurableObjectState`-slice value to hand the instance builder. */
	readonly state: LiveDoState;
	/** Whether an alarm is currently scheduled (tests assert on this). */
	readonly hasAlarm: () => boolean;
}

/**
 * Build a test DO state with its own KV `Map` + single alarm slot. Each call is
 * one DO instance; `id` is the instance name (`connection:<id>` / `topic:<key>`)
 * that {@link resolveRole} reads off `state.id.name`. Pass `kv` to share storage
 * across instances (the same named DO surviving an eviction).
 */
export function makeDurableObjectStateForTest(options?: {
	readonly id?: string;
	readonly kv?: Map<string, unknown>;
}): DurableObjectStateForTest {
	const kv = options?.kv ?? new Map<string, unknown>();
	let alarm: number | null = null;

	// `storage` is typed as the `LiveDoState["storage"]` slice — exactly what
	// {@link makeLiveInstance} touches. Each method is a generic `Effect` closure
	// cast to its precise `Storage[...]` member signature (`as Storage["get"]`,
	// etc.) — member-typed casts, never `as any`/`as unknown as`, so the fake's
	// shape still lines up with the real DO-state signature.
	type Storage = LiveDoState["storage"];

	const storage: Storage = {
		get: (<T>(key: string) => Effect.sync(() => kv.get(key) as T | undefined)) as Storage["get"],
		put: (<T>(key: string, value: T) =>
			Effect.sync(() => {
				kv.set(key, value);
			})) as Storage["put"],
		// MUST accept both a single key and an array (publish bulk-deletes rows).
		delete: ((keyOrKeys: string | ReadonlyArray<string>) =>
			Effect.sync(() => {
				const keys = typeof keyOrKeys === "string" ? [keyOrKeys] : keyOrKeys;
				for (const key of keys) {
					kv.delete(key);
				}
			})) as Storage["delete"],
		// Returns `Effect<Map<string, T>>` — a prefix-filtered copy of the backing
		// Map (not the live Map, so callers can't mutate the store through it).
		list: (<T>({prefix}: {readonly prefix: string}) =>
			Effect.sync(() => {
				const out = new Map<string, T>();
				for (const [key, value] of kv) {
					if (key.startsWith(prefix)) {
						out.set(key, value as T);
					}
				}
				return out;
			})) as Storage["list"],
		getAlarm: (() => Effect.sync(() => alarm)) as Storage["getAlarm"],
		setAlarm: ((scheduledTime: number) =>
			Effect.sync(() => {
				alarm = scheduledTime;
			})) as Storage["setAlarm"],
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
