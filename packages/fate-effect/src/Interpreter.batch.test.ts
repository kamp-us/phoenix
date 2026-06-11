/**
 * `FateInterpreter` — the v2-only execution properties around the oracle
 * (tasks.md tasks 14–17): the RequestResolver batch window (where N+1 dies),
 * concurrent dispatch, and span nesting (the cutover observability AC,
 * task 17 / ADR 0043).
 *
 * These suites pin behavior the byte-equality corpus cannot: how many times
 * a source loader runs, that operations are in flight concurrently, and
 * which span a handler parents to. The one deliberate v1/v2 WIRE divergence
 * (byId served from `config.sources`) is also pinned here, loudly, against
 * both backends from the shared sozluk world (`Oracle.fixture.ts`).
 */
import {Effect, Layer, ManagedRuntime, Tracer} from "effect";
import {describe, expect, it} from "vitest";
import {FateDataView} from "./DataView.ts";
import {FateInterpreter} from "./Interpreter.ts";
import {Fate} from "./index.ts";
import {
	logSpan,
	makeV1,
	makeV2,
	type OracleStep,
	observe,
	recordingPublisher,
	requestOf,
	spanLog,
} from "./Oracle.fixture.ts";
import {FateServer} from "./Server.ts";

// --- the batch window (v2-only: where N+1 dies) ------------------------------------

type CountedRow = {id: string; label: string};

class CountedView extends FateDataView<CountedRow>()("Counted")({id: true, label: true}) {}
class SingularView extends FateDataView<CountedRow>()("Singular")({id: true, label: true}) {}

describe("FateInterpreter — RequestResolver-batched sources", () => {
	const makeCountingWorld = () => {
		const byIdsCalls: Array<ReadonlyArray<string>> = [];
		const byIdCalls: Array<string> = [];
		const countedRows: ReadonlyArray<CountedRow> = [
			{id: "c1", label: "bir"},
			{id: "c2", label: "iki"},
			{id: "c3", label: "üç"},
		];
		const singularRows: ReadonlyArray<CountedRow> = [
			{id: "s1", label: "tek"},
			{id: "s2", label: "çift"},
		];
		const counted = Fate.source(
			CountedView,
			{id: "id"},
			{
				byIds: (ids) =>
					Effect.sync(() => {
						byIdsCalls.push(ids);
						return countedRows.filter((row) => ids.includes(row.id));
					}),
			},
		);
		const singular = Fate.source(
			SingularView,
			{id: "id"},
			{
				byId: (id) =>
					Effect.sync(() => {
						byIdCalls.push(id);
						return singularRows.find((row) => row.id === id) ?? null;
					}),
			},
		);
		const runtime = ManagedRuntime.make(
			FateServer.layer(FateServer.config({sources: [counted, singular]})),
		);
		return {
			byIdCalls,
			byIdsCalls,
			dispose: () => runtime.dispose(),
			handle: (step: OracleStep) =>
				runtime
					.runPromise(
						FateInterpreter.handleRequest(requestOf(step), {
							currentUser: {user: undefined},
							livePublisher: recordingPublisher().publisher,
						}),
					)
					.then((response) => response.text())
					.then((text) => JSON.parse(text) as unknown),
		};
	};

	it("N same-entity byId operations in one protocol request make exactly ONE byIds call", async () => {
		const world = makeCountingWorld();
		try {
			const body = await world.handle({
				label: "one window",
				operations: [
					{id: "1", kind: "byId", type: "Counted", ids: ["c1", "c2"], select: ["label"]},
					{id: "2", kind: "byId", type: "Counted", ids: ["c2", "c3"], select: ["label"]},
					{id: "3", kind: "byId", type: "Counted", ids: ["c1"], select: ["label"]},
				],
			});
			expect(body).toEqual({
				results: [
					{
						data: [
							{id: "c1", label: "bir"},
							{id: "c2", label: "iki"},
						],
						id: "1",
						ok: true,
					},
					{
						data: [
							{id: "c2", label: "iki"},
							{id: "c3", label: "üç"},
						],
						id: "2",
						ok: true,
					},
					{data: [{id: "c1", label: "bir"}], id: "3", ok: true},
				],
				version: 1,
			});
			expect(world.byIdsCalls).toHaveLength(1);
			expect([...world.byIdsCalls.flat()].sort()).toEqual(["c1", "c2", "c3"]);
		} finally {
			await world.dispose();
		}
	});

	it("duplicate ids within a batch are deduped before reaching the source", async () => {
		const world = makeCountingWorld();
		try {
			await world.handle({
				label: "dupes",
				operations: [
					{id: "1", kind: "byId", type: "Counted", ids: ["c1", "c1", "c2"], select: ["label"]},
					{id: "2", kind: "byId", type: "Counted", ids: ["c2", "c1"], select: ["label"]},
				],
			});
			expect(world.byIdsCalls).toHaveLength(1);
			expect([...world.byIdsCalls.flat()].sort()).toEqual(["c1", "c2"]);
		} finally {
			await world.dispose();
		}
	});

	it("byId-only sources load each unique id once; per-op data keeps ids order and duplicates", async () => {
		const world = makeCountingWorld();
		try {
			const body = await world.handle({
				label: "byId-only dedupe",
				operations: [
					{id: "1", kind: "byId", type: "Singular", ids: ["s1", "s2", "s1"], select: ["label"]},
					{id: "2", kind: "byId", type: "Singular", ids: ["s2"], select: ["label"]},
				],
			});
			expect(body).toEqual({
				results: [
					{
						data: [
							{id: "s1", label: "tek"},
							{id: "s2", label: "çift"},
							{id: "s1", label: "tek"},
						],
						id: "1",
						ok: true,
					},
					{data: [{id: "s2", label: "çift"}], id: "2", ok: true},
				],
				version: 1,
			});
			expect([...world.byIdCalls].sort()).toEqual(["s1", "s2"]);
		} finally {
			await world.dispose();
		}
	});

	it("the batch window is one protocol request, not the runtime lifetime", async () => {
		const world = makeCountingWorld();
		try {
			const step: OracleStep = {
				label: "request 1",
				operations: [{id: "1", kind: "byId", type: "Counted", ids: ["c1"], select: ["label"]}],
			};
			await world.handle(step);
			await world.handle(step);
			expect(world.byIdsCalls).toHaveLength(2);
		} finally {
			await world.dispose();
		}
	});

	it("v2 serves byId from config.sources where the v1 compiled server (roots: {}) cannot", async () => {
		// DELIBERATE divergence, pinned loudly: the v1 compiled server passes
		// `roots: {}` (ADR 0016/0019), which leaves fate's `sourcesByType` empty —
		// every byId is NOT_FOUND and the registered sources are dead code. The
		// interpreter resolves byId from `config.sources` directly, making the
		// registered loaders reachable. fate's client CAN emit `kind: "byId"`
		// (cache-miss node fetches, missing-field refetches, and the
		// live-payload fallback in `fetchLiveRecord`) — v1 serves all of those
		// NOT_FOUND today, so the divergence is error→data: strictly additive
		// on the wire, and at cutover it FIXES the latent live-refetch
		// breakage rather than introducing one.
		const v1 = makeV1();
		const v2 = makeV2();
		const step: OracleStep = {
			label: "byId Term",
			operations: [
				{id: "1", kind: "byId", type: "Term", ids: ["effect"], select: ["slug", "title"]},
			],
		};
		try {
			const baseline = await observe(v1, step);
			const candidate = await observe(v2, step);
			expect(JSON.parse(baseline.text)).toEqual({
				results: [
					{
						error: {code: "NOT_FOUND", message: "No source registered for 'Term'."},
						id: "1",
						ok: false,
					},
				],
				version: 1,
			});
			expect(JSON.parse(candidate.text)).toEqual({
				results: [{data: [{slug: "effect", title: "Effect"}], id: "1", ok: true}],
				version: 1,
			});
		} finally {
			await v1.dispose();
			await v2.dispose();
		}
	});
});

// --- the dispatch loop runs operations concurrently --------------------------------

describe("FateInterpreter — concurrent dispatch", () => {
	it("operations within one request are in flight concurrently (fate's Promise.all)", async () => {
		// Both handlers hold at a 2-party barrier: sequential dispatch would
		// deadlock (vitest timeout); concurrent dispatch releases both.
		const waiters: Array<() => void> = [];
		const arrive = () =>
			new Promise<void>((resolve) => {
				waiters.push(resolve);
				if (waiters.length >= 2) {
					for (const release of waiters) {
						release();
					}
				}
			});
		const paired = Fate.query(
			{type: "Paired"},
			Effect.fn("paired")(function* () {
				yield* Effect.promise(() => arrive());
				return {ok: true};
			}),
		);
		const runtime = ManagedRuntime.make(FateServer.layer(FateServer.config({queries: {paired}})));
		try {
			const response = await runtime.runPromise(
				FateInterpreter.handleRequest(
					requestOf({
						label: "paired",
						operations: [
							{id: "1", kind: "query", name: "paired", select: []},
							{id: "2", kind: "query", name: "paired", select: []},
						],
					}),
					{currentUser: {user: undefined}, livePublisher: recordingPublisher().publisher},
				),
			);
			expect(JSON.parse(await response.text())).toEqual({
				results: [
					{data: {ok: true}, id: "1", ok: true},
					{data: {ok: true}, id: "2", ok: true},
				],
				version: 1,
			});
		} finally {
			await runtime.dispose();
		}
	});
});

// --- span nesting (the cutover observability AC, task 17 / ADR 0043) ---------------
//
// v2 owns no runtime: `handleRequest` runs on the CALLER's fiber, so every
// handler/source `Effect.fn` span must parent to the caller's ambient span —
// in production that is the router's request span (the `HttpEffect.toHandled`
// tracer middleware sets it on the request fiber). The harness simulates the
// route fiber by carrying a `Tracer.ParentSpan` in the runtime context, the
// same collector idiom as `Executor.test.ts` § observability. The byId arm is
// the risky one — source loads run through the walk's `RequestResolver`
// batch fiber, which must not detach from the request span.

describe("FateInterpreter — observability", () => {
	it("handler and batched-source spans nest under the route's request span", async () => {
		class SpannedView extends FateDataView<{id: string}>()("Spanned")({id: true}) {}
		const spannedSource = Fate.source(
			SpannedView,
			{id: "id"},
			{
				byIds: function* (ids) {
					// Inside the constructor-owned `Spanned.byIds` span.
					yield* logSpan;
					return ids.map((id) => ({id}));
				},
			},
		);
		const spanned = Fate.query(
			{type: "Spanned"},
			Effect.fn("spanned")(function* () {
				yield* logSpan;
				return {ok: true};
			}),
		);

		// The runtime context carries the request span — the stand-in for the
		// route fiber's ambient `ParentSpan`.
		const runtime = ManagedRuntime.make(
			Layer.mergeAll(
				FateServer.layer(FateServer.config({queries: {spanned}, sources: [spannedSource]})),
				Layer.succeed(Tracer.ParentSpan)(
					Tracer.externalSpan({spanId: "route-span", traceId: "route-trace"}),
				),
			),
		);
		// Earlier suites in this file ran fixture handlers that log spans too —
		// observe only THIS request's spans.
		spanLog.length = 0;
		try {
			const response = await runtime.runPromise(
				FateInterpreter.handleRequest(
					requestOf({
						label: "spans",
						operations: [
							{id: "1", kind: "query", name: "spanned", select: []},
							{id: "2", kind: "byId", type: "Spanned", ids: ["s1"], select: ["id"]},
						],
					}),
					{currentUser: {user: undefined}, livePublisher: recordingPublisher().publisher},
				),
			);
			expect(response.status).toBe(200);
			// Both spans — the operation handler's wire-name span AND the source
			// handler's constructor-owned span (reached through the
			// RequestResolver batch window) — parent to the request span, never
			// a detached root.
			expect([...spanLog].sort((a, b) => (a.name < b.name ? -1 : 1))).toEqual([
				{name: "Spanned.byIds", parent: "route-span"},
				{name: "spanned", parent: "route-span"},
			]);
		} finally {
			await runtime.dispose();
		}
	});
});
