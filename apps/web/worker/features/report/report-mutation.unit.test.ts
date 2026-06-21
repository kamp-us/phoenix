/**
 * `report.submit` WIRE-boundary unit coverage (ADR 0082) — the parts that are
 * wrong-or-right with no database: the `CurrentUser.required` auth gate, the
 * `ReportTargetNotFound` → per-feature not-found translation by `targetKind`, and
 * the `ReportReceipt` shape (its `__typename` discriminant + `<kind>:<id>` id). The
 * `Report` seam is substituted directly (`Layer.succeed(Report, …)`) with a stub
 * whose `submit` returns a scripted `ReportResult` or fails `ReportTargetNotFound` —
 * no engine, so this is a unit test.
 *
 * The persistence / idempotency / all-three-kinds facts that are only wrong if real
 * D1 differs live in `apps/web/tests/integration/report.test.ts`; the `Report.submit`
 * service decisions (created/no-op, target liveness) live in `Report.unit.test.ts`.
 */

import {assert, describe, it} from "@effect/vitest";
import {CurrentUser} from "@kampus/fate-effect";
import {Cause, Effect, type Layer} from "effect";
import {resolveWire} from "../fate/resolve-wire.testing.ts";
import {ReportTargetNotFound} from "./errors.ts";
import {mutations} from "./mutations.ts";
import {makeReportStub} from "./Report.testing.ts";
import type {Report, ReportInput, ReportResult} from "./Report.ts";

const REPORTER = {id: "u-reporter", email: "elif@example.com", name: "elif"};

// Drive the op through its real external interface (`resolveWire`: `resolve`
// decode + the `encodeWireError` class→wire-code seam), not `.handler` — so the
// failure assertions see the WIRE `code` a client gets, and a mis-annotated
// `[FateWireCode]` (e.g. on `PostNotFound`) is a unit failure, not just an
// integration-tier one.
const submit = (
	input: {targetKind: "post" | "comment" | "definition"; targetId: string; reason?: string | null},
	user?: typeof REPORTER,
) =>
	resolveWire(mutations["report.submit"], {
		input,
		select: ["id", "targetKind", "targetId", "created"],
	}).pipe(Effect.provideService(CurrentUser, {user}));

// The wire `code` carried by a `resolveWire` failure `Cause` (the `FateRequestError`
// `encodeWireError` produced), or `undefined` if the cause holds no error / on success.
const wireCodeOf = (cause: Cause.Cause<unknown>): unknown => {
	const error = Cause.findErrorOption(cause);
	return error._tag === "Some" ? (error.value as {code?: unknown}).code : undefined;
};

// A `Report` stub that hands `submit` whatever the test scripts — a landed
// `ReportResult` or a `ReportTargetNotFound`. Every other method fails-on-contact
// via the shared stub: this boundary only ever touches `submit`, so a reached
// presence read / idempotency path (`Report.unit.test.ts`'s job) fails the test.
const reportStub = (
	respond: (input: ReportInput) => Effect.Effect<ReportResult, ReportTargetNotFound>,
): Layer.Layer<Report> => makeReportStub({submit: respond});

const landed = (input: ReportInput): Effect.Effect<ReportResult> =>
	Effect.succeed({targetKind: input.targetKind, targetId: input.targetId, created: true});

const notFound = (input: ReportInput): Effect.Effect<never, ReportTargetNotFound> =>
	Effect.fail(
		new ReportTargetNotFound({
			targetKind: input.targetKind,
			targetId: input.targetId,
			message: `report target ${input.targetKind} ${input.targetId} not found`,
		}),
	);

describe("report.submit wire boundary — auth gate (no DB)", () => {
	it.effect("an anonymous submit fails the wire UNAUTHORIZED before the service is touched", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				submit({targetKind: "post", targetId: "p1"}).pipe(
					Effect.provide(
						reportStub(() => Effect.die(new Error("Report.submit ran on an anonymous request"))),
					),
				),
			);
			assert.isTrue(exit._tag === "Failure");
			if (exit._tag === "Failure") {
				assert.strictEqual(wireCodeOf(exit.cause), "UNAUTHORIZED");
			}
		}),
	);
});

describe("report.submit wire boundary — ReportTargetNotFound translates by targetKind", () => {
	// The per-feature not-found WIRE codes — what `encodeWireError` derives from each
	// translated class's `[FateWireCode]`. Asserting the code (not the class name in the
	// cause string) is what catches a mis-annotated `PostNotFound` etc.
	const cases = [
		{targetKind: "post" as const, wireCode: "POST_NOT_FOUND"},
		{targetKind: "comment" as const, wireCode: "COMMENT_NOT_FOUND"},
		{targetKind: "definition" as const, wireCode: "DEFINITION_NOT_FOUND"},
	];
	for (const {targetKind, wireCode} of cases) {
		it.effect(`a missing ${targetKind} target → ${wireCode} (never the raw service code)`, () =>
			Effect.gen(function* () {
				const exit = yield* Effect.exit(
					submit({targetKind, targetId: "ghost"}, REPORTER).pipe(
						Effect.provide(reportStub(notFound)),
					),
				);
				assert.isTrue(exit._tag === "Failure");
				if (exit._tag === "Failure") {
					// The translated per-feature code, never `INTERNAL_SERVER_ERROR` (which an
					// un-translated, un-annotated `ReportTargetNotFound` would have encoded to).
					assert.strictEqual(wireCodeOf(exit.cause), wireCode);
				}
			}),
		);
	}
});

describe("report.submit wire boundary — receipt shape (the shaper, no DB)", () => {
	it.effect(
		"a landed submit returns a ReportReceipt stamped with __typename + <kind>:<id> id",
		() =>
			Effect.gen(function* () {
				const receipt = yield* submit(
					{targetKind: "post", targetId: "p1", reason: "spam"},
					REPORTER,
				).pipe(Effect.provide(reportStub(landed)));
				assert.deepStrictEqual(receipt, {
					__typename: "ReportReceipt",
					id: "post:p1",
					targetKind: "post",
					targetId: "p1",
					created: true,
				});
			}),
	);
});
