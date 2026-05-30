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
 * NOT a production artifact — it lives under `__support__/` and is never imported
 * by the worker graph.
 */
import type * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

type DurableObjectStateValue = Cloudflare.DurableObjectState["Service"];

export interface FakeDurableObjectState {
	/** The `DurableObjectState`-shaped service value to hand the instance builder. */
	readonly state: DurableObjectStateValue;
	/** Whether an alarm is currently scheduled (tests assert on this). */
	readonly hasAlarm: () => boolean;
}

/**
 * Build a fake DO state with its own KV `Map` + single alarm slot. Each call is
 * one DO instance; `id` is the instance name (`connection:<id>` / `topic:<key>`)
 * that {@link resolveRole} reads off `state.id.name`. Pass `kv` to share storage
 * across instances (the same named DO surviving an eviction).
 */
export function makeFakeDurableObjectState(options?: {
	readonly id?: string;
	readonly kv?: Map<string, unknown>;
}): FakeDurableObjectState {
	const kv = options?.kv ?? new Map<string, unknown>();
	let alarm: number | null = null;

	const state = {
		id: {toString: () => options?.id ?? "fake-do", name: options?.id} as never,
		storage: {
			get: (<T>(key: string) => Effect.sync(() => kv.get(key) as T | undefined)) as never,
			put: (<T>(key: string, value: T) =>
				Effect.sync(() => {
					kv.set(key, value);
				})) as never,
			// MUST accept both a single key and an array (publish bulk-deletes rows).
			delete: ((keyOrKeys: string | ReadonlyArray<string>) =>
				Effect.sync(() => {
					if (Array.isArray(keyOrKeys)) {
						for (const key of keyOrKeys) {
							kv.delete(key);
						}
					} else {
						kv.delete(keyOrKeys as string);
					}
				})) as never,
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
				})) as never,
			getAlarm: () => Effect.sync(() => alarm),
			setAlarm: ((scheduledTime: number) =>
				Effect.sync(() => {
					alarm = scheduledTime;
				})) as never,
		} as never,
	} as unknown as DurableObjectStateValue;

	return {
		state,
		hasAlarm: () => alarm !== null,
	};
}
