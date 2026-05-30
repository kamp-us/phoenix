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
 * Per ADR 0029 the bridge provides a captured `Context` and runs on the default
 * runtime — no `ManagedRuntime`. A `FateContext` only needs `{context, request}`;
 * we build a `Context` carrying just the services each test body yields (`Auth`),
 * so the tests stay focused on the seam, not the full feature graph.
 */

import {FateRequestError} from "@nkzw/fate/server";
import {Context, Data, Effect} from "effect";
import {describe, expect, it} from "vitest";
import {Auth, Unauthorized} from "../pasaport/Auth";
import type {FateContext} from "./context";
import {fateMutation, fateQuery, fateSource} from "./effect";

// A domain tagged error whose `_tag` `encodeFateError` knows.
class BodyRequired extends Data.TaggedError("sozluk/BodyRequired")<{
	readonly message: string;
}> {}

/**
 * Build a `FateContext` whose captured `Context` carries an `Auth` service with
 * the given user (or anonymous). The bridge only reads `ctx.context`; the cast
 * to the full `FateEnv` is safe because the test bodies yield only `Auth`.
 */
const makeCtx = (user?: {id: string}): FateContext => {
	const context = Context.make(Auth, {
		user: user as never,
		session: undefined,
	}) as unknown as FateContext["context"];
	return {context, request: new Request("http://test/fate")};
};

const invoke = <A>(
	fn: (o: {ctx: FateContext; input: {args?: undefined}; select: Array<string>}) => Promise<A>,
	ctx: FateContext,
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
		class Weird extends Data.TaggedError("weird/Unknown")<{readonly message: string}> {}
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
		const executor = fateSource<{id: string; name: string}>({
			byId: function* (id) {
				yield* Effect.void;
				return {id, name: `row-${id}`};
			},
		});
		const row = await executor.byId?.({ctx: makeCtx(), id: "x", plan: PLAN});
		expect(row).toEqual({id: "x", name: "row-x"});
	});

	it("byIds returns a mutable array (spread) of rows", async () => {
		const executor = fateSource<{id: string}>({
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
		const executor = fateSource<{id: string}>({
			byId: function* () {
				return yield* new Unauthorized({message: "no"});
			},
		});
		const err = await executor.byId?.({ctx: makeCtx(), id: "x", plan: PLAN}).catch((e) => e);
		expect(err.code).toBe("UNAUTHORIZED");
	});

	it("only defines the handlers that were provided", () => {
		const executor = fateSource<{id: string}>({
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
