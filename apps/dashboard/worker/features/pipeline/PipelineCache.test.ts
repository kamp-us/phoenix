/**
 * Reproduction + regression test for #323 — the `/api/pipeline` CF 1101.
 *
 * Two bugs lived at the cache DO's RPC boundary; the encode schema was a red herring.
 * `Pipeline.test.ts` stubs `PipelineCache` directly with a `Layer.succeed`, so it
 * never crosses this boundary — which is why CI stayed green while prod 500'd. This
 * test closes that gap by driving the cache DO instance through `proxyStub` (a
 * faithful mirror of the alchemy RPC stub's get-trap) AND replaying the worker-side
 * seam's exact read/write composition over it.
 *
 * Bug 1 — method-vs-property. The alchemy RPC stub (`makeRpcStub`,
 * `alchemy/Cloudflare/Workers/Rpc`) proxies EVERY member access as a callable and
 * invokes it. A `PipelineCacheRpc.read` declared as a bare-Effect property resolved
 * to the proxy *function*, never the Effect, so `Effect.suspend(() => stub().read)`
 * died "Not a valid effect" → CF 1101. The fix makes `read` a method, called
 * `stub().read()`.
 *
 * Bug 2 — non-serializable RPC return. Once `read()` ran, the DO decoded the blob
 * and returned a `CachedPipelineState` CLASS instance over RPC — which Cloudflare
 * can't structured-clone ("Could not serialize object of type CachedPipelineState").
 * The fix makes the DO dumb storage (raw JSON in/out) and moves the schema
 * encode/decode worker-side into `PipelineCache`. The boundary now only carries
 * plain JSON.
 */
import {assert, describe, it} from "@effect/vitest";
import * as Effect from "effect/Effect";
import {makePipelineCacheInstance, type PipelineCacheRpc} from "./cache-do.ts";
import {makePipelineCacheStateForTest} from "./do-state.testing.ts";
import {
	CachedPipelineState,
	decodeCachedPipelineState,
	encodeCachedPipelineState,
	PipelineState,
} from "./schema.ts";

/**
 * A faithful mirror of the alchemy RPC stub's `get` trap (`makeRpcStub`,
 * `alchemy/Cloudflare/Workers/Rpc`): every member access returns a CALLABLE that
 * dispatches to the backing instance's same-named member. This is what makes the
 * boundary require methods, not bare-Effect properties (Bug 1). `makeRpcStub` itself
 * is not in alchemy's public `exports`, so we replicate its observable get-trap shape
 * here rather than reach into an unpublished subpath.
 */
const proxyStub = (instance: PipelineCacheRpc): PipelineCacheRpc =>
	new Proxy(instance, {
		get:
			(target, prop) =>
			(...args: ReadonlyArray<unknown>) => {
				const member = Reflect.get(target, prop) as (...a: ReadonlyArray<unknown>) => unknown;
				return member(...args);
			},
	}) as PipelineCacheRpc;

/**
 * Replays `PipelineCache`'s exact read/write composition over a stub — the seam under
 * test. `write` encodes worker-side then hands plain JSON across; `read` calls the
 * method, then decodes worker-side, degrading an undecodable/absent blob to `null`.
 */
const seamOver = (stub: () => PipelineCacheRpc) => ({
	read: Effect.suspend(() => stub().read()).pipe(
		Effect.flatMap((raw) =>
			raw === null
				? Effect.succeed(null)
				: decodeCachedPipelineState(raw).pipe(Effect.orElseSucceed(() => null)),
		),
	),
	write: (s: CachedPipelineState) =>
		encodeCachedPipelineState(s).pipe(
			Effect.orDie,
			Effect.flatMap((encoded) => stub().write(encoded)),
		),
});

const snapshot = new CachedPipelineState({
	state: new PipelineState({issues: [], epics: []}),
	fetchedAt: 1_700_000_000_000,
});

const freshStub = () => {
	const instance = makePipelineCacheInstance(makePipelineCacheStateForTest().state);
	return () => proxyStub(instance);
};

describe("PipelineCache over the alchemy RPC stub boundary (#323)", () => {
	it.effect("read — the seam's call shape — is a valid Effect (cold cache → null)", () =>
		Effect.gen(function* () {
			// Bug 1: pre-fix `Effect.suspend(() => stub().read)` (property) died here.
			const result = yield* seamOver(freshStub()).read;
			assert.strictEqual(result, null);
		}),
	);

	it.effect("write then read round-trips a snapshot across the proxy boundary", () =>
		Effect.gen(function* () {
			const seam = seamOver(freshStub());
			yield* seam.write(snapshot);
			const read = yield* seam.read;

			assert.isNotNull(read);
			assert.strictEqual(read!.fetchedAt, snapshot.fetchedAt);
			assert.isTrue(read!.state instanceof PipelineState);
		}),
	);

	it.effect("the value crossing the RPC boundary is plain JSON, never a class instance", () =>
		Effect.gen(function* () {
			// Bug 2: the DO must return structured-cloneable JSON. A class instance crossing
			// RPC throws "Could not serialize object of type CachedPipelineState". Assert the
			// DO `read()` hands back a plain object (round-trips through structuredClone) and
			// is NOT a `CachedPipelineState` — the decode is the seam's job, worker-side.
			const stub = freshStub();
			const encoded = yield* encodeCachedPipelineState(snapshot);
			yield* stub().write(encoded);

			const raw = yield* stub().read();
			assert.isFalse(
				raw instanceof CachedPipelineState,
				"raw RPC value must not be a class instance",
			);
			// structuredClone throws on a non-serializable value — proves it's clone-safe.
			assert.deepStrictEqual(structuredClone(raw), encoded);
		}),
	);

	it("stub().read (property, the pre-fix shape) is NOT a runnable Effect — it's the proxy fn", () => {
		// Bug 1 in isolation: through the proxy, `stub().read` is the get-trap's callable,
		// not an Effect — so `Effect.isEffect` is false and suspending over it dies "Not a
		// valid effect" (CF 1101). The fix is to CALL it: `stub().read()`.
		const property: unknown = Reflect.get(freshStub()(), "read");
		assert.strictEqual(typeof property, "function");
		assert.isFalse(
			Effect.isEffect(property as never),
			"the property is the proxy fn, not an Effect",
		);
	});
});
