/**
 * `FateInterpreter` — the v2 dispatch loop under the DIFFERENTIAL ORACLE:
 * the harness smoke test plus the sozluk operation corpus.
 *
 * The oracle's contract: any protocol request runs through BOTH backends —
 * the v1 compiled server (fate's own `handleRequest` over
 * `FateExecutor.toFetchHandler`) and the v2 native interpreter
 * (`FateInterpreter.handleRequest`) — and the raw wire output must be
 * BYTE-EQUAL: same status, same content-type, same body text. The harness,
 * the sozluk fixture world, and the byte-equality assertion live in
 * `Oracle.fixture.ts` (shared with `Executor.test.ts`, the baseline's own
 * pin suite); each backend owns an isolated runtime over its own fresh
 * in-memory database, so mutations advance both worlds in lockstep and later
 * reads prove state parity, not just response parity.
 *
 * This file's corpus covers the NAMED operation kinds end to end —
 * successes, every error class (annotated, UNAUTHORIZED, VALIDATION_ERROR,
 * NOT_FOUND, defects, `FateRequestError` passthrough with issues),
 * batching/order, dispatch-time BAD_REQUESTs, request-level
 * malformed-protocol rejections, and fate's acceptance leniency. The other
 * oracle planes live in siblings: `Interpreter.walk.test.ts` (byId + the
 * selection walk + its connection plane), `Interpreter.features.test.ts`
 * (the pano / pasaport / stats feature-shaped corpus), and
 * `Interpreter.batch.test.ts` (RequestResolver batching, concurrency,
 * observability).
 */
import {describe, expect, it} from "vitest";
import {assertParity, makeV1, makeV2, type OracleStep, user} from "./Oracle.fixture.ts";

// --- the harness itself (one operation, raw wire JSON diffed) ---------------------

describe("the differential oracle harness", () => {
	it("runs one operation through both backends and diffs the raw wire JSON", async () => {
		const v1 = makeV1();
		const v2 = makeV2();
		try {
			const baseline = await assertParity(v1, v2, {
				label: "term query",
				operations: [
					{id: "1", kind: "query", name: "term", args: {slug: "effect", take: "2"}, select: []},
				],
			});
			// The diffed output is fate's own wire JSON (sanity: not vacuous).
			expect(JSON.parse(baseline.text)).toEqual({
				results: [{data: {slug: "effect", take: 2, title: "Effect"}, id: "1", ok: true}],
				version: 1,
			});
			expect(baseline.status).toBe(200);
		} finally {
			await v1.dispose();
			await v2.dispose();
		}
	});
});

// --- the corpus (queries + mutations, success and error, in lockstep) -------------

describe("the sozluk oracle corpus — queries and mutations", () => {
	it("every corpus step is byte-equal across both backends", async () => {
		const umut = user("umut");
		const steps: ReadonlyArray<OracleStep> = [
			// -- queries: success shapes --
			{
				label: "query success with Schema-decoded args",
				operations: [
					{id: "1", kind: "query", name: "term", args: {slug: "effect", take: "2"}, select: []},
				],
			},
			{
				label: "query miss yields null data",
				operations: [{id: "1", kind: "query", name: "term", args: {slug: "yok"}, select: []}],
			},
			{
				label: "empty operations array",
				operations: [],
			},
			// -- queries: error shapes --
			{
				label: "unknown query is NOT_FOUND",
				operations: [{id: "1", kind: "query", name: "nope", select: []}],
			},
			{
				label: "query args rejected by the definition Schema",
				operations: [{id: "1", kind: "query", name: "term", args: {slug: 42}, select: []}],
			},
			{
				label: "defect collapses to the fixed internal error",
				operations: [{id: "1", kind: "query", name: "boom", select: []}],
			},
			{
				label: "died FateRequestError passes through verbatim, issues included",
				operations: [{id: "1", kind: "query", name: "forbidden", select: []}],
			},
			{
				label: "empty operation name is a per-operation BAD_REQUEST",
				operations: [{id: "1", kind: "query", name: "", select: []}],
			},
			// -- fate's acceptance leniency --
			{
				label: "junk in kind-unchecked fields is accepted and ignored",
				operations: [
					{
						id: "1",
						kind: "query",
						name: "term",
						args: {slug: "fate"},
						select: [],
						ids: "junk",
						type: 42,
					},
				],
			},
			// -- mutations: the write path, advancing both worlds --
			{
				label: "anonymous mutation is UNAUTHORIZED",
				operations: [
					{
						id: "1",
						kind: "mutation",
						name: "definition.add",
						input: {term: "effect", body: "tanım"},
						select: [],
					},
				],
			},
			{
				label: "mutation success writes and publishes",
				user: umut,
				operations: [
					{
						id: "1",
						kind: "mutation",
						name: "definition.add",
						input: {term: "effect", body: "bir efekt sistemi"},
						select: [],
					},
				],
			},
			{
				label: "a later read observes the write (state parity)",
				operations: [
					{id: "1", kind: "query", name: "definitions", args: {term: "effect"}, select: []},
				],
			},
			{
				label: "declared annotated error keeps its wire code",
				user: umut,
				operations: [
					{
						id: "1",
						kind: "mutation",
						name: "definition.add",
						input: {term: "effect", body: ""},
						select: [],
					},
				],
			},
			{
				label: "invalid mutation input is VALIDATION_ERROR",
				user: umut,
				operations: [
					{id: "1", kind: "mutation", name: "definition.add", input: {term: 1}, select: []},
				],
			},
			{
				label: "unknown mutation is NOT_FOUND",
				user: umut,
				operations: [{id: "1", kind: "mutation", name: "definition.nope", input: {}, select: []}],
			},
			{
				label: "vote mutation mutates prior state",
				user: umut,
				operations: [
					{id: "1", kind: "mutation", name: "definition.vote", input: {id: "def-1"}, select: []},
				],
			},
			{
				label: "vote on a missing target is the annotated error",
				user: umut,
				operations: [
					{id: "1", kind: "mutation", name: "definition.vote", input: {id: "def-99"}, select: []},
				],
			},
			// -- batching: order preserved, mixed outcomes. NOTE: no operation in
			// the batch reads what another WRITES — intra-batch read-after-write
			// is racy under BOTH backends (fate's Promise.all and the
			// interpreter's unbounded forEach interleave differently); only
			// cross-request reads are deterministic, and the oracle only pins
			// deterministic wire output. --
			{
				label: "a mixed batch preserves operation order",
				user: umut,
				operations: [
					{id: "a", kind: "query", name: "term", args: {slug: "fate"}, select: []},
					{id: "b", kind: "query", name: "nope", select: []},
					{id: "c", kind: "query", name: "boom", select: []},
					{
						id: "d",
						kind: "mutation",
						name: "definition.add",
						input: {term: "fate", body: "kader"},
						select: [],
					},
					// reads PRIOR-request state ("effect" definitions), not "fate"'s
					{id: "e", kind: "query", name: "definitions", args: {term: "effect"}, select: []},
				],
			},
			{
				label: "the batch write is visible to the NEXT request",
				operations: [
					{id: "1", kind: "query", name: "definitions", args: {term: "fate"}, select: []},
				],
			},
			// -- a list smoke case (the full corpus: the features + walk suites) --
			{
				label: "list operation parity (smoke)",
				operations: [{id: "1", kind: "list", name: "terms", args: {first: 1}, select: []}],
			},
			{
				label: "unknown list is NOT_FOUND",
				operations: [{id: "1", kind: "list", name: "nope", select: []}],
			},
		];

		const v1 = makeV1();
		const v2 = makeV2();
		try {
			for (const step of steps) {
				await assertParity(v1, v2, step);
			}
		} finally {
			await v1.dispose();
			await v2.dispose();
		}
	});

	it("malformed protocol requests reject byte-equally, status included", async () => {
		const steps: ReadonlyArray<OracleStep> = [
			{label: "invalid JSON body", rawBody: "{nope"},
			{label: "wrong version", body: {version: 2, operations: []}},
			{label: "operations not an array", body: {version: 1, operations: {}}},
			{label: "non-record body", body: "x"},
			{label: "operation not a record", body: {version: 1, operations: ["x"]}},
			{
				label: "operation id not a string",
				body: {version: 1, operations: [{id: 1, kind: "query", name: "term", select: []}]},
			},
			{
				label: "unknown kind",
				body: {version: 1, operations: [{id: "1", kind: "nope", select: []}]},
			},
			{
				label: "select not strings",
				body: {version: 1, operations: [{id: "1", kind: "query", name: "term", select: [1]}]},
			},
			{
				label: "args not a record",
				body: {
					version: 1,
					operations: [{id: "1", kind: "query", name: "term", select: [], args: []}],
				},
			},
			{
				label: "byId without ids",
				body: {version: 1, operations: [{id: "1", kind: "byId", type: "Term", select: []}]},
			},
			{
				label: "named op without name",
				body: {version: 1, operations: [{id: "1", kind: "query", select: []}]},
			},
		];
		const v1 = makeV1();
		const v2 = makeV2();
		try {
			for (const step of steps) {
				const baseline = await assertParity(v1, v2, step);
				expect(baseline.status, step.label).toBe(400);
			}
		} finally {
			await v1.dispose();
			await v2.dispose();
		}
	});
});
