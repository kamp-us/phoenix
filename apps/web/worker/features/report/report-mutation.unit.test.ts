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
import {Effect, Layer} from "effect";
import {ReportTargetNotFound} from "./errors.ts";
import {mutations} from "./mutations.ts";
import {Report, type ReportInput, type ReportResult} from "./Report.ts";

const REPORTER = {id: "u-reporter", email: "elif@example.com", name: "elif"};

const submit = (
	input: {targetKind: "post" | "comment" | "definition"; targetId: string; reason?: string | null},
	user?: typeof REPORTER,
) =>
	mutations["report.submit"]
		.handler({input, select: ["id", "targetKind", "targetId", "created"]})
		.pipe(Effect.provideService(CurrentUser, {user}));

// A `Report` stub that hands `submit` whatever the test scripts — a landed
// `ReportResult` or a `ReportTargetNotFound`. The presence read and idempotency
// envelope are the service's job (`Report.unit.test.ts`), not the wire boundary's.
const reportStub = (
	respond: (input: ReportInput) => Effect.Effect<ReportResult, ReportTargetNotFound>,
) =>
	Layer.succeed(Report, {submit: respond, readByReporter: () => Effect.succeed(new Set<string>())});

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
	it.effect("an anonymous submit fails UNAUTHORIZED before the service is touched", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				submit({targetKind: "post", targetId: "p1"}).pipe(
					Effect.provide(
						reportStub(() => Effect.die(new Error("Report.submit ran on an anonymous request"))),
					),
				),
			);
			assert.isTrue(exit._tag === "Failure");
			assert.match(String(exit._tag === "Failure" ? exit.cause : ""), /Unauthorized/);
		}),
	);
});

describe("report.submit wire boundary — ReportTargetNotFound translates by targetKind", () => {
	const cases = [
		{targetKind: "post" as const, code: "PostNotFound"},
		{targetKind: "comment" as const, code: "CommentNotFound"},
		{targetKind: "definition" as const, code: "DefinitionNotFound"},
	];
	for (const {targetKind, code} of cases) {
		it.effect(`a missing ${targetKind} target → ${code} (never the raw service error)`, () =>
			Effect.gen(function* () {
				const exit = yield* Effect.exit(
					submit({targetKind, targetId: "ghost"}, REPORTER).pipe(
						Effect.provide(reportStub(notFound)),
					),
				);
				assert.isTrue(exit._tag === "Failure");
				const cause = String(exit._tag === "Failure" ? exit.cause : "");
				assert.match(cause, new RegExp(code));
				assert.notMatch(cause, /ReportTargetNotFound/);
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
