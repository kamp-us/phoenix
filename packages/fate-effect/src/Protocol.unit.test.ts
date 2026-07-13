/**
 * `Protocol` — the v2 wire-protocol codecs.
 *
 * Three contracts under test:
 *
 *   1. **Round-trip** — the canonical codecs decode every operation kind and
 *      encode back byte-identically. The canonical schemas ARE fate's
 *      exported protocol types in Schema form.
 *   2. **fate-faithful rejection** — `decodeProtocolRequest` is fate's
 *      `assertProtocolRequest` as a staged Schema decode: malformed requests
 *      fail with fate's OWN error shape (`FateRequestError`, `BAD_REQUEST`,
 *      the exact message per stage), and fate's LENIENCY is preserved too —
 *      fields fate does not check per kind (junk `ids` on a query) pass, so
 *      the differential oracle cannot diverge on acceptance.
 *   3. **The drift pin** — type-level `satisfies`-style pins against fate's
 *      EXPORTED protocol types (`FateOperation`, `FateProtocolRequest`,
 *      `FateProtocolResponse` and the result/error members derived from
 *      them). `Wire<>` normalizes mutability only (fate types mutable arrays;
 *      Schema types ReadonlyArray — the wire cannot tell). Keys, optionality,
 *      and value types stay exact, so a fate upgrade that drifts the protocol
 *      fails `tsgo` here before any runtime test runs.
 */
import type {FateOperation, FateProtocolRequest, FateProtocolResponse} from "@nkzw/fate";
import {FateRequestError} from "@nkzw/fate/server";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {describe, expect, expectTypeOf, it} from "vitest";
import {
	decodeProtocolRequest,
	type ProtocolError,
	type ProtocolFailureResult,
	ProtocolOperation,
	ProtocolRequest,
	ProtocolResponse,
	type ProtocolSuccessResult,
} from "./Protocol.ts";

const decodeOp = Schema.decodeUnknownSync(ProtocolOperation);
const encodeOp = Schema.encodeUnknownSync(ProtocolOperation);
const decodeRequest = Schema.decodeUnknownSync(ProtocolRequest);
const encodeRequest = Schema.encodeUnknownSync(ProtocolRequest);
const decodeResponse = Schema.decodeUnknownSync(ProtocolResponse);
const encodeResponse = Schema.encodeUnknownSync(ProtocolResponse);

/** Round-trip a wire value through decode→encode and return the JSON bytes. */
const roundTrip = (codec: {
	decode: (value: unknown) => unknown;
	encode: (value: unknown) => unknown;
}) => {
	return (wire: unknown): {original: string; output: string} => ({
		original: JSON.stringify(wire),
		output: JSON.stringify(codec.encode(codec.decode(wire))),
	});
};

const opTrip = roundTrip({decode: decodeOp, encode: encodeOp});

const expectRejection = (body: unknown, message: string): void => {
	const error = Effect.runSync(Effect.flip(decodeProtocolRequest(body)));
	expect(error).toBeInstanceOf(FateRequestError);
	// fate's exact error shape: code, message, and the derived 400 status.
	expect(error.code).toBe("BAD_REQUEST");
	expect(error.message).toBe(message);
	expect(error.status).toBe(400);
};

const expectAccepted = (body: unknown) => Effect.runSync(decodeProtocolRequest(body));

const requestOf = (operations: ReadonlyArray<unknown>) => ({version: 1, operations});

describe("Protocol — canonical round-trips", () => {
	it("round-trips every operation kind byte-identically", () => {
		const operations = [
			// byId: type + ids (string and numeric protocol ids).
			{id: "1", ids: ["t-1", 2], kind: "byId", select: ["title"], type: "Term"},
			// list: name + args.
			{args: {first: 10}, id: "2", kind: "list", name: "terms", select: ["slug", "title"]},
			// mutation: name + input (+ select).
			{
				id: "3",
				input: {body: "tanım", term: "effect"},
				kind: "mutation",
				name: "definition.add",
				select: [],
			},
			// query: name + args.
			{args: {slug: "effect", take: "2"}, id: "4", kind: "query", name: "term", select: []},
		];
		for (const operation of operations) {
			const {original, output} = opTrip(operation);
			expect(output, `kind ${String((operation as {kind: unknown}).kind)}`).toBe(original);
		}
	});

	it("round-trips the request envelope", () => {
		// Canonical field order (operations, version) — requests are consumed,
		// never re-emitted, so canonicalization is harmless; the byte contract
		// lives on the RESPONSE side.
		const wire = {operations: [{id: "1", kind: "query", name: "term", select: []}], version: 1};
		expect(JSON.stringify(encodeRequest(decodeRequest(wire)))).toBe(JSON.stringify(wire));
	});

	it("round-trips the response envelope — success, error, and error-with-issues arms", () => {
		const wire = {
			results: [
				{data: {slug: "effect", title: "Effect"}, id: "1", ok: true},
				{
					error: {code: "NOT_FOUND", message: "No query registered for 'nope'."},
					id: "2",
					ok: false,
				},
				{
					error: {
						code: "VALIDATION_ERROR",
						issues: [{path: ["term"]}],
						message: "Validation failed.",
					},
					id: "3",
					ok: false,
				},
			],
			version: 1,
		};
		expect(JSON.stringify(encodeResponse(decodeResponse(wire)))).toBe(JSON.stringify(wire));
	});

	it("encodes in fate's serialization order regardless of input field order", () => {
		// fate builds result objects literally as {data, id, ok} / {error, id, ok}
		// with errors as {code, issues, message}; the codecs canonicalize to the
		// same order, which is what makes byte-equality achievable at all.
		const out = encodeResponse(
			decodeResponse({
				version: 1,
				results: [
					{ok: true, id: "a", data: null},
					{ok: false, id: "b", error: {message: "m", issues: ["i"], code: "C"}},
				],
			}),
		);
		expect(JSON.stringify(out)).toBe(
			'{"results":[{"data":null,"id":"a","ok":true},{"error":{"code":"C","issues":["i"],"message":"m"},"id":"b","ok":false}],"version":1}',
		);
	});
});

describe("decodeProtocolRequest — fate's assertProtocolRequest, staged", () => {
	it("accepts a valid mixed-kind request and yields validated operations", () => {
		const operations = expectAccepted(
			requestOf([
				{id: "1", kind: "query", name: "term", args: {slug: "effect"}, select: []},
				{id: "2", kind: "mutation", name: "definition.add", input: {term: "effect"}, select: []},
				{id: "3", kind: "byId", type: "Term", ids: ["t-1", 2], select: ["title"]},
				{id: "4", kind: "list", name: "terms", select: []},
			]),
		);
		expect(operations).toHaveLength(4);
		expect(operations[0]).toMatchObject({kind: "query", name: "term", args: {slug: "effect"}});
		expect(operations[1]).toMatchObject({kind: "mutation", input: {term: "effect"}});
		expect(operations[2]).toMatchObject({kind: "byId", type: "Term", ids: ["t-1", 2]});
	});

	it("rejects a malformed envelope with fate's request message", () => {
		for (const body of [
			null,
			"x",
			42,
			[],
			{},
			{version: 2, operations: []},
			{version: 1},
			{version: 1, operations: {}},
		]) {
			expectRejection(body, "Invalid Fate protocol request.");
		}
	});

	it("rejects a malformed operation with fate's operation message", () => {
		const bad = [
			"not-a-record",
			{kind: "query", name: "term", select: []}, // no id
			{id: 1, kind: "query", name: "term", select: []}, // id not a string
			{id: "1", kind: "nope", select: []}, // unknown kind
			{id: "1", kind: "query", name: "term", select: "title"}, // select not an array
			{id: "1", kind: "query", name: "term", select: [1]}, // select not strings
			{id: "1", kind: "query", name: "term", select: [], args: []}, // args not a record (fate's isRecord excludes arrays)
			{id: "1", kind: "query", name: "term", select: [], args: "x"},
		];
		for (const operation of bad) {
			expectRejection(requestOf([operation]), "Invalid Fate protocol operation.");
		}
	});

	it("rejects a malformed byId operation with fate's byId message", () => {
		const bad = [
			{id: "1", kind: "byId", select: []}, // no type, no ids
			{id: "1", kind: "byId", type: 42, ids: ["a"], select: []},
			{id: "1", kind: "byId", type: "Term", select: []}, // no ids
			{id: "1", kind: "byId", type: "Term", ids: "a", select: []},
			{id: "1", kind: "byId", type: "Term", ids: [true], select: []}, // not protocol ids
		];
		for (const operation of bad) {
			expectRejection(requestOf([operation]), "Invalid Fate byId operation.");
		}
	});

	it("rejects a named operation without a string name with fate's named message", () => {
		for (const kind of ["list", "mutation", "query"]) {
			expectRejection(requestOf([{id: "1", kind, select: []}]), "Invalid Fate named operation.");
			expectRejection(
				requestOf([{id: "1", kind, name: 42, select: []}]),
				"Invalid Fate named operation.",
			);
		}
	});

	it("the FIRST malformed operation wins — fate validates in order", () => {
		expectRejection(
			requestOf([
				{id: "1", kind: "byId", select: []}, // byId failure first…
				{id: 2, kind: "query", select: []}, // …despite a base failure later
			]),
			"Invalid Fate byId operation.",
		);
	});

	it("preserves fate's leniency: fields unchecked for a kind pass through", () => {
		// fate's assert checks ids/type ONLY for byId and name ONLY for named
		// kinds — a query with junk in those fields is accepted (and ignored).
		expectAccepted(
			requestOf([
				{id: "1", kind: "query", name: "term", select: [], ids: "junk", type: 42},
				{id: "2", kind: "byId", type: "Term", ids: ["a"], select: [], name: 99, input: "noise"},
				// an empty name passes the assert; fate rejects it at DISPATCH time
				{id: "3", kind: "query", name: "", select: []},
			]),
		);
	});
});

/**
 * Normalize mutability ONLY: fate declares mutable arrays/records where the
 * codecs produce readonly ones — indistinguishable on the wire. Keys,
 * optionality, and value types pass through untouched, so any real protocol
 * drift in the pinned fate version still fails typecheck.
 */
type Wire<T> =
	T extends ReadonlyArray<infer E>
		? ReadonlyArray<Wire<E>>
		: T extends object
			? {readonly [K in keyof T]: Wire<T[K]>}
			: T;

type FateOperationResult = FateProtocolResponse["results"][number];
type FateSuccessResult = Extract<FateOperationResult, {readonly ok: true}>;
type FateFailureResult = Extract<FateOperationResult, {readonly ok: false}>;
type FateWireError = FateFailureResult["error"];
type FateWireErrorCode = FateWireError["code"];

type PhoenixOperation = (typeof ProtocolOperation)["Type"];
type PhoenixRequest = (typeof ProtocolRequest)["Type"];
type PhoenixResponse = (typeof ProtocolResponse)["Type"];
type PhoenixSuccess = (typeof ProtocolSuccessResult)["Type"];
type PhoenixFailure = (typeof ProtocolFailureResult)["Type"];
type PhoenixError = (typeof ProtocolError)["Type"];

/**
 * The deliberate code WIDENING (WireError.ts): phoenix's wire vocabulary
 * (`BODY_REQUIRED`, …) is wider than fate's closed 6-member union, so the
 * codec types `code: string`. The pin substitutes fate's union back in and
 * demands EXACT equality on everything else.
 */
type PinnedError = {
	readonly [K in keyof PhoenixError]: K extends "code" ? FateWireErrorCode : PhoenixError[K];
};
type PinnedFailure = {
	readonly [K in keyof PhoenixFailure]: K extends "error" ? PinnedError : PhoenixFailure[K];
};

describe("Protocol — the fate drift pin", () => {
	it("the canonical schemas pin fate's exported protocol types", () => {
		expectTypeOf<Wire<PhoenixOperation>>().toEqualTypeOf<Wire<FateOperation>>();
		expectTypeOf<Wire<PhoenixRequest>>().toEqualTypeOf<Wire<FateProtocolRequest>>();
		expectTypeOf<Wire<PhoenixSuccess>>().toEqualTypeOf<Wire<FateSuccessResult>>();
		expectTypeOf<Wire<PinnedFailure>>().toEqualTypeOf<Wire<FateFailureResult>>();
		expectTypeOf<Wire<PinnedError>>().toEqualTypeOf<Wire<FateWireError>>();
		expectTypeOf<PhoenixResponse["version"]>().toEqualTypeOf<FateProtocolResponse["version"]>();
		// And directionally: everything fate emits decodes through our codecs
		// (fate's narrow codes extend the codec's deliberately wider string).
		expectTypeOf<Wire<FateProtocolResponse>>().toExtend<Wire<PhoenixResponse>>();
	});
});
