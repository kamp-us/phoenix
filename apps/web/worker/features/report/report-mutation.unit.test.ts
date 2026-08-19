/**
 * `report.submit` WIRE-boundary unit coverage (ADR 0082). Persistence/idempotency facts
 * live in `tests/integration/report.test.ts`; the service's own decisions live in
 * `Report.unit.test.ts`.
 */

import {assert, describe, it} from "@effect/vitest";
import {CurrentActor, human, RelationStore, unauthenticated} from "@kampus/authz";
import {CurrentUser, LivePublisher} from "@kampus/fate-effect";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Cause, Effect, Layer} from "effect";
import {TargetId} from "../../lib/ids.ts";
import {makeNotificationStub} from "../bildirim/Notification.testing.ts";
import {noRequestFlagOverrides, resolveWire} from "../fate/resolve-wire.testing.ts";
import {livePublisherFor} from "../fate-live/live-publisher.ts";
import {Flags} from "../flagship/Flags.ts";
import {Kunye} from "../kunye/Kunye.ts";
import {ReportTargetNotFound} from "./errors.ts";
import {mutations} from "./mutations.ts";
import {makeReportStub} from "./Report.testing.ts";
import type {Report, ReportInput, ReportResult} from "./Report.ts";

const REPORTER = {id: "u-reporter", email: "elif@example.com", name: "elif"};

const runtimeContextStub: BaseRuntimeContext = {
	Type: "report-mutation-test",
	id: "report-mutation-test",
	env: {},
	get: () => Effect.succeed(undefined),
	set: (id) => Effect.succeed(id),
};

// `Flags` OFF ⇒ the mod emit (#1699) no-ops before any moderator read or notification
// write, so the stubs below exist only to satisfy the type and die if ever reached.
const bildirimOffStub = Layer.mergeAll(
	Layer.succeed(Flags, {
		getBoolean: () => Effect.succeed(false),
		getString: () => Effect.die("getString not exercised"),
		getNumber: () => Effect.die("getNumber not exercised"),
		getObject: () => Effect.die("getObject not exercised"),
	} as typeof Flags.Service),
	Layer.succeed(RuntimeContext, runtimeContextStub),
	noRequestFlagOverrides,
	makeNotificationStub(),
	Layer.succeed(LivePublisher)(livePublisherFor({publish: () => Effect.void, waitUntil: () => {}})),
	Layer.succeed(RelationStore, {
		has: () => Effect.die("RelationStore.has not exercised in report-mutation"),
		hasSubjects: () => Effect.die("RelationStore.hasSubjects not exercised in report-mutation"),
		subjectsOf: () => Effect.die("RelationStore.subjectsOf not exercised in report-mutation"),
	}),
	// Flag off ⇒ the `CanFlag` gate auto-passes without a karma read (#150).
	Layer.succeed(Kunye, {
		karmaOf: () => Effect.die("Kunye.karmaOf not exercised in report-mutation (flag off)"),
		tierOf: () => Effect.die("Kunye.tierOf not exercised in report-mutation"),
		rootOf: (id: string) => Effect.succeed(id),
	} as typeof Kunye.Service),
);

const submit = (
	input: {targetKind: "post" | "comment" | "definition"; targetId: string; reason?: string | null},
	user?: typeof REPORTER,
) =>
	resolveWire(mutations["report.submit"], {
		input,
		select: ["id", "targetKind", "targetId", "created"],
	}).pipe(
		Effect.provideService(CurrentUser, {user}),
		Effect.provideService(CurrentActor, {actor: user ? human(user.id) : unauthenticated}),
		Effect.provide(bildirimOffStub),
	);

const wireCodeOf = (cause: Cause.Cause<unknown>): unknown => {
	const error = Cause.findErrorOption(cause);
	return error._tag === "Some" ? (error.value as {code?: unknown}).code : undefined;
};

// Every method but `submit` fails-on-contact, so a reached presence/idempotency path
// (`Report.unit.test.ts`'s job) fails the test instead of passing quietly.
const reportStub = (
	respond: (input: ReportInput) => Effect.Effect<ReportResult, ReportTargetNotFound>,
): Layer.Layer<Report> => makeReportStub({submit: respond});

const landed = (input: ReportInput): Effect.Effect<ReportResult> =>
	Effect.succeed({targetKind: input.targetKind, targetId: input.targetId, created: true});

const notFound = (input: ReportInput): Effect.Effect<never, ReportTargetNotFound> =>
	Effect.fail(
		new ReportTargetNotFound({
			targetKind: input.targetKind,
			targetId: TargetId.make(input.targetId),
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
	// Asserting the wire code, not the class name in the cause string, is what catches a
	// mis-annotated `[FateWireCode]`.
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
