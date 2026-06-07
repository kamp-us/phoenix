/**
 * Bridge isolation tests — the fate ↔ Effect seam's success/failure mapping.
 *
 * These verify the three branches of {@link runEffect} (via the public
 * wrappers) in isolation — no workerd, no real D1, no fate server:
 *
 *   - `Exit.Success`          → resolves with the value.
 *   - tagged domain failure   → rejects with a `FateRequestError` whose `code`
 *                               is what `encodeFateError` maps the `_tag` to.
 *   - `FateRequestError`      → passes through verbatim (not re-encoded).
 *   - defect (uncaught throw) → squashed → `encodeFateError` → `INTERNAL_*`.
 *
 * The F4 model (ADR 0041, supersedes 0029): every resolver runs THROUGH a
 * worker-level `ManagedRuntime` carried on the `FateContext` as `ctx.runtime`,
 * with the per-request `Auth` + `LiveBus` VALUES provided onto each resolver
 * effect. These tests build a tiny EMPTY marker runtime (the bodies here yield
 * only `Auth` and `Effect.void`, never a worker service) and per-request
 * `auth`/`liveBus` values, so the seam — not the full feature graph — is under
 * test. The full 7-behavior suite (incl. the span-nesting F4 proof) lands in
 * the feature's task 2.
 */

import {FateRequestError} from "@nkzw/fate/server";
import {Effect, Layer, ManagedRuntime} from "effect";
import * as Schema from "effect/Schema";
import {describe, expect, it} from "vitest";
import {liveBusFor} from "../fate-live/event-bus";
import {Auth, Unauthorized} from "../pasaport/Auth";
import type {FateContext} from "./context";
import {fateMutation, fateQuery, fateSource} from "./effect";

// A domain tagged error whose `_tag` `encodeFateError` knows.
class BodyRequired extends Schema.TaggedErrorClass<BodyRequired>()("sozluk/BodyRequired", {
	message: Schema.String,
}) {}

/**
 * Build a `FateContext` over an EMPTY marker `ManagedRuntime` (the bodies here
 * yield only `Auth` + `Effect.void`, so the runtime carries no worker service),
 * plus the per-request `Auth` + `LiveBus` VALUES the bridge provides onto each
 * resolver effect. Generic in `never` — no cast, thanks to `FateContext<R>`.
 */
const makeCtx = (user?: {id: string}): FateContext<never> => {
	const runtime = ManagedRuntime.make(Layer.empty);
	const auth: typeof Auth.Service = {user: user as never, session: undefined};
	const liveBus = liveBusFor(() => {});
	return {runtime, request: new Request("http://test/fate"), auth, liveBus};
};

const invoke = <A>(
	fn: (o: {
		ctx: FateContext<never>;
		input: {args?: undefined};
		select: Array<string>;
	}) => Promise<A>,
	ctx: FateContext<never>,
): Promise<A> => fn({ctx, input: {args: undefined}, select: []});

// fate's source handlers receive a `plan` (the masking plan) that the bridge
// wrapper ignores — it just runs the generator. Tests don't build a real plan,
// so they pass this sentinel for the unused field.
const PLAN = undefined as never;

describe("fateQuery", () => {
	it("resolves with the Effect's success value", async () => {
		const resolve = fateQuery<undefined, {ok: true}>(function* () {
			yield* Effect.void;
			return {ok: true};
		});
		await expect(invoke(resolve, makeCtx())).resolves.toEqual({ok: true});
	});

	it("resolves data produced by a service method (Auth.required)", async () => {
		const resolve = fateQuery<undefined, {id: string}>(function* () {
			const {user} = yield* Auth.required;
			return {id: user.id};
		});
		await expect(invoke(resolve, makeCtx({id: "u1"}))).resolves.toEqual({id: "u1"});
	});

	it("maps a tagged domain failure to its FateRequestError wire code", async () => {
		const resolve = fateQuery<undefined, never>(function* () {
			return yield* new BodyRequired({message: "tanım boş olamaz"});
		});
		await expect(invoke(resolve, makeCtx())).rejects.toMatchObject({
			code: "BODY_REQUIRED",
		});
	});

	it("maps Unauthorized → UNAUTHORIZED", async () => {
		const resolve = fateQuery<undefined, {id: string}>(function* () {
			const {user} = yield* Auth.required; // anonymous → Unauthorized
			return {id: user.id};
		});
		const err = await invoke(resolve, makeCtx()).catch((e) => e);
		expect(err).toBeInstanceOf(FateRequestError);
		expect(err.code).toBe("UNAUTHORIZED");
	});

	it("passes a pre-built FateRequestError through verbatim", async () => {
		const sentinel = new FateRequestError("NOT_FOUND", "nope");
		const resolve = fateQuery<undefined, never>(function* () {
			return yield* Effect.fail(sentinel);
		});
		const err = await invoke(resolve, makeCtx()).catch((e) => e);
		expect(err).toBe(sentinel);
	});

	it("squashes a defect (uncaught throw) to an internal error", async () => {
		const resolve = fateQuery<undefined, never>(function* () {
			yield* Effect.void;
			throw new Error("boom");
		});
		const err = await invoke(resolve, makeCtx()).catch((e) => e);
		expect(err).toBeInstanceOf(FateRequestError);
		expect(err.code).toBe("INTERNAL_SERVER_ERROR");
	});

	it("maps an unknown tagged error to an internal error", async () => {
		class Weird extends Schema.TaggedErrorClass<Weird>()("weird/Unknown", {
			message: Schema.String,
		}) {}
		const resolve = fateQuery<undefined, never>(function* () {
			return yield* new Weird({message: "?"});
		});
		const err = await invoke(resolve, makeCtx()).catch((e) => e);
		expect(err.code).toBe("INTERNAL_SERVER_ERROR");
	});
});

describe("fateMutation", () => {
	it("resolves the Effect's success value", async () => {
		const resolve = fateMutation<{n: number}, number>(function* ({input}) {
			yield* Effect.void;
			return input.n * 2;
		});
		await expect(resolve({ctx: makeCtx(), input: {n: 3}, select: []})).resolves.toBe(6);
	});

	it("maps a tagged failure to its wire code", async () => {
		const resolve = fateMutation<Record<never, never>, never>(function* () {
			return yield* new Unauthorized({message: "no"});
		});
		const err = await resolve({ctx: makeCtx(), input: {}, select: []}).catch((e) => e);
		expect(err.code).toBe("UNAUTHORIZED");
	});
});

describe("fateSource", () => {
	it("byId resolves a raw row through the runtime", async () => {
		const executor = fateSource<{id: string; name: string}, never>({
			byId: function* (id) {
				yield* Effect.void;
				return {id, name: `row-${id}`};
			},
		});
		const row = await executor.byId?.({ctx: makeCtx(), id: "x", plan: PLAN});
		expect(row).toEqual({id: "x", name: "row-x"});
	});

	it("byIds returns a mutable array (spread) of rows", async () => {
		const executor = fateSource<{id: string}, never>({
			byIds: function* (ids) {
				yield* Effect.void;
				return ids.map((id) => ({id}));
			},
		});
		const rows = await executor.byIds?.({ctx: makeCtx(), ids: ["a", "b"], plan: PLAN});
		expect(rows).toEqual([{id: "a"}, {id: "b"}]);
		expect(Array.isArray(rows)).toBe(true);
	});

	it("maps a failing source executor to a wire error", async () => {
		const executor = fateSource<{id: string}, never>({
			byId: function* () {
				return yield* new Unauthorized({message: "no"});
			},
		});
		const err = await executor.byId?.({ctx: makeCtx(), id: "x", plan: PLAN}).catch((e) => e);
		expect(err.code).toBe("UNAUTHORIZED");
	});

	it("only defines the handlers that were provided", () => {
		const executor = fateSource<{id: string}, never>({
			byId: function* (id) {
				yield* Effect.void;
				return {id};
			},
		});
		expect(executor.byId).toBeTypeOf("function");
		expect(executor.byIds).toBeUndefined();
		expect(executor.connection).toBeUndefined();
	});
});
