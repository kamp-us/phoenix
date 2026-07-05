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
import {CurrentActor, human, RelationStore, unauthenticated} from "@kampus/authz";
import {CurrentUser, LivePublisher} from "@kampus/fate-effect";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Cause, Effect, Layer} from "effect";
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

// The mod-emitter deps `report.submit` gained (#1699): the report-filed page rides
// AFTER the committed submit. `Flags` OFF ⇒ `bildirimOn` is false ⇒ the emit no-ops
// before the moderator read or any notification write, so the Notification /
// RelationStore stubs exist only to satisfy the type and die if ever reached.
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
	// `Notification.record` rides `LivePublisher` (the per-recipient live delivery seam,
	// #2076) — a static requirement of the mod emit even though the flag-off path never
	// records. A no-op publisher satisfies it; it is never reached.
	Layer.succeed(LivePublisher)(livePublisherFor({publish: () => Effect.void, waitUntil: () => {}})),
	Layer.succeed(RelationStore, {
		has: () => Effect.die("RelationStore.has not exercised in report-mutation"),
		hasSubjects: () => Effect.die("RelationStore.hasSubjects not exercised in report-mutation"),
		subjectsOf: () => Effect.die("RelationStore.subjectsOf not exercised in report-mutation"),
	}),
	// The karma flag-gate deps `report.submit` gained (#150): `Flags` OFF ⇒ the
	// `CanFlag` gate auto-passes without a karma read, so `Kunye.karmaOf` is never
	// exercised (it dies on contact); `CanFlag.authorize` still stamps its proof off
	// `CurrentActor`, provided per-call in `submit`.
	Layer.succeed(Kunye, {
		karmaOf: () => Effect.die("Kunye.karmaOf not exercised in report-mutation (flag off)"),
		tierOf: () => Effect.die("Kunye.tierOf not exercised in report-mutation"),
		rootOf: (id: string) => Effect.succeed(id),
	} as typeof Kunye.Service),
);

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
	}).pipe(
		Effect.provideService(CurrentUser, {user}),
		Effect.provideService(CurrentActor, {actor: user ? human(user.id) : unauthenticated}),
		Effect.provide(bildirimOffStub),
	);

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
