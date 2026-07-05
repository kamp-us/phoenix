/**
 * Mod-queue emitter coverage (#1699) — the decisions wrong-or-right with no database
 * (ADR 0082 T1/T2; `.patterns/effect-testing.md`): moderator resolution + actor
 * self-suppression, the flag containment (dark by default), the çaylak-entry 0→1
 * transition gate, and the swallow-at-the-seam guarantee — a DYING dependency (the
 * `orDieAccess` defect shape) cannot fail the caller. The `Notification` / `Divan` /
 * `RelationStore` seams are fail-on-contact stubs with only the exercised method
 * overridden, so "touched the wrong surface" is a test failure.
 */
import {assert, describe, it} from "@effect/vitest";
import {RelationStore} from "@kampus/authz";
import {CurrentUser, LivePublisher} from "@kampus/fate-effect";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Effect, Layer} from "effect";
import {Divan} from "../divan/Divan.ts";
import {noRequestFlagOverrides} from "../fate/resolve-wire.testing.ts";
import {Flags} from "../flagship/Flags.ts";
import {
	CAYLAK_PENDING_KIND,
	modRecipients,
	notifyCaylakEntersDivan,
	notifyReportFiled,
	REPORT_FILED_KIND,
} from "./mod-emitters.ts";
import {makeNotificationStub} from "./Notification.testing.ts";
import type {NotificationRecordInput} from "./Notification.ts";

const runtimeContextStub: BaseRuntimeContext = {
	Type: "mod-emitters-test",
	id: "mod-emitters-test",
	env: {},
	get: () => Effect.succeed(undefined),
	set: (id) => Effect.succeed(id),
};

const flagsStub = (on: boolean): Layer.Layer<Flags> =>
	Layer.succeed(Flags, {
		getBoolean: () => Effect.succeed(on),
		getString: () => Effect.die("getString not exercised"),
		getNumber: () => Effect.die("getNumber not exercised"),
		getObject: () => Effect.die("getObject not exercised"),
	} as typeof Flags.Service);

// A no-op `LivePublisher`: `Notification.record` yields the per-request publisher for
// the fire-and-forget live fan-out (#2076). The stub `record` never touches it, so a
// do-nothing publisher satisfies the requirement without asserting on it.
const noopLivePublisher = Layer.succeed(LivePublisher)({
	update: () => Effect.void,
	delete: () => Effect.void,
	topic: () => {
		throw new Error("noopLivePublisher.topic unused");
	},
} as typeof LivePublisher.Service);

const requestContext = (on: boolean) =>
	Layer.mergeAll(
		flagsStub(on),
		Layer.succeed(CurrentUser, {user: undefined}),
		Layer.succeed(RuntimeContext, runtimeContextStub),
		noRequestFlagOverrides,
		noopLivePublisher,
	);

// A `RelationStore` where exactly `mods` hold the `(moderates, platform)` tuple — the
// authority model the recipient set is resolved from (never a hardcoded list).
const relationStoreOf = (mods: ReadonlyArray<string>): Layer.Layer<RelationStore> =>
	Layer.succeed(RelationStore, {
		has: () => Effect.die(new Error("mod-emitters resolve via subjectsOf, not has")),
		hasSubjects: () =>
			Effect.die(new Error("mod-emitters resolve via subjectsOf, not hasSubjects")),
		subjectsOf: ({relation, object}) =>
			Effect.succeed(new Set(relation === "moderates" && object.type === "platform" ? mods : [])),
	});

// A `Divan` whose `pendingCountOf` answers a scripted count; the other reads die.
const divanPending = (count: number): Layer.Layer<Divan> =>
	Layer.succeed(Divan, {
		roster: () => Effect.die(new Error("Divan.roster not exercised")),
		backlogOf: () => Effect.die(new Error("Divan.backlogOf not exercised")),
		pendingCountOf: () => Effect.succeed(count),
	});

const divanDies: Layer.Layer<Divan> = Layer.succeed(Divan, {
	roster: () => Effect.die(new Error("Divan.roster not exercised")),
	backlogOf: () => Effect.die(new Error("Divan.backlogOf not exercised")),
	pendingCountOf: () => Effect.die(new Error("Divan.pendingCountOf must not be read")),
});

describe("modRecipients — moderator resolution + actor self-suppression, pure", () => {
	it("returns every moderator, deterministically ordered, when the actor is not one", () => {
		assert.deepStrictEqual(modRecipients(new Set(["u-mod-b", "u-mod-a"]), "u-reporter"), [
			"u-mod-a",
			"u-mod-b",
		]);
	});
	it("suppresses the acting moderator — no self-notification for their own action", () => {
		assert.deepStrictEqual(modRecipients(new Set(["u-mod-a", "u-mod-b"]), "u-mod-a"), ["u-mod-b"]);
	});
	it("a null actor (a system moment) suppresses no one", () => {
		assert.deepStrictEqual(modRecipients(new Set(["u-mod-a"]), null), ["u-mod-a"]);
	});
	it("an empty moderator set resolves to nobody", () => {
		assert.deepStrictEqual(modRecipients(new Set(), "u-reporter"), []);
	});
});

describe("notifyReportFiled — the report-filed mod page", () => {
	it.effect(
		"records one report-filed notification per moderator, targeting the reported content",
		() =>
			Effect.gen(function* () {
				const calls: NotificationRecordInput[] = [];
				yield* notifyReportFiled({
					reporterId: "u-reporter",
					targetKind: "post",
					targetId: "p1",
				}).pipe(
					Effect.provide(
						Layer.mergeAll(
							makeNotificationStub({
								record: (input) => {
									calls.push(input);
									return Effect.succeed({id: "n1"});
								},
							}),
							relationStoreOf(["u-mod-a", "u-mod-b"]),
							requestContext(true),
						),
					),
				);
				assert.strictEqual(calls.length, 2);
				assert.deepStrictEqual(calls[0], {
					recipientId: "u-mod-a",
					kind: REPORT_FILED_KIND,
					targetKind: "post",
					targetId: "p1",
					actorId: "u-reporter",
				});
				assert.deepStrictEqual(calls[1]?.recipientId, "u-mod-b");
			}),
	);

	it.effect(
		"a moderator who files a report is NOT paged about their own report (self-suppression)",
		() =>
			Effect.gen(function* () {
				const calls: NotificationRecordInput[] = [];
				yield* notifyReportFiled({
					reporterId: "u-mod-a",
					targetKind: "comment",
					targetId: "c1",
				}).pipe(
					Effect.provide(
						Layer.mergeAll(
							makeNotificationStub({
								record: (input) => {
									calls.push(input);
									return Effect.succeed({id: "n1"});
								},
							}),
							relationStoreOf(["u-mod-a", "u-mod-b"]),
							requestContext(true),
						),
					),
				);
				assert.deepStrictEqual(
					calls.map((c) => c.recipientId),
					["u-mod-b"],
				);
			}),
	);

	it.effect("no moderators ⇒ the fail-on-contact Notification stub is never touched", () =>
		notifyReportFiled({reporterId: "u-reporter", targetKind: "post", targetId: "p1"}).pipe(
			Effect.provide(
				Layer.mergeAll(makeNotificationStub(), relationStoreOf([]), requestContext(true)),
			),
		),
	);

	it.effect("with the bildirim flag OFF nothing is read or written (dark by default)", () =>
		notifyReportFiled({reporterId: "u-reporter", targetKind: "post", targetId: "p1"}).pipe(
			Effect.provide(
				Layer.mergeAll(
					makeNotificationStub(),
					// RelationStore dies on contact: flag-off must not even resolve moderators.
					Layer.succeed(RelationStore, {
						has: () => Effect.die(new Error("flag OFF must not read authority")),
						hasSubjects: () => Effect.die(new Error("flag OFF must not read authority")),
						subjectsOf: () => Effect.die(new Error("flag OFF must not read authority")),
					}),
					requestContext(false),
				),
			),
		),
	);

	it.effect(
		"a DYING notification write is swallowed — the report caller still succeeds (the seam AC)",
		() =>
			Effect.gen(function* () {
				const exit = yield* notifyReportFiled({
					reporterId: "u-reporter",
					targetKind: "post",
					targetId: "p1",
				}).pipe(
					Effect.provide(
						Layer.mergeAll(
							makeNotificationStub(),
							relationStoreOf(["u-mod-a"]),
							requestContext(true),
						),
					),
					Effect.exit,
				);
				assert.strictEqual(exit._tag, "Success");
			}),
	);
});

describe("notifyCaylakEntersDivan — the çaylak-awaiting-review page, 0→1 transition-gated", () => {
	it.effect(
		"a live item (sandboxedAt null) is not a divan entry — nothing is read or written",
		() =>
			notifyCaylakEntersDivan({authorId: "u-caylak", sandboxedAt: null}).pipe(
				Effect.provide(
					Layer.mergeAll(
						makeNotificationStub(),
						relationStoreOf(["u-mod-a"]),
						divanDies,
						requestContext(true),
					),
				),
			),
	);

	it.effect("the çaylak's FIRST pending item (count 1) pages every moderator", () =>
		Effect.gen(function* () {
			const calls: NotificationRecordInput[] = [];
			yield* notifyCaylakEntersDivan({
				authorId: "u-caylak",
				sandboxedAt: new Date("2026-01-01T00:00:00Z"),
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						makeNotificationStub({
							record: (input) => {
								calls.push(input);
								return Effect.succeed({id: "n1"});
							},
						}),
						relationStoreOf(["u-mod-a", "u-mod-b"]),
						divanPending(1),
						requestContext(true),
					),
				),
			);
			assert.strictEqual(calls.length, 2);
			assert.deepStrictEqual(calls[0], {
				recipientId: "u-mod-a",
				kind: CAYLAK_PENDING_KIND,
				targetKind: "user",
				targetId: "u-caylak",
				actorId: null,
			});
		}),
	);

	it.effect("a çaylak's SECOND+ pending item (count > 1) pages nobody — no re-notify", () =>
		notifyCaylakEntersDivan({
			authorId: "u-caylak",
			sandboxedAt: new Date("2026-01-01T00:00:00Z"),
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					makeNotificationStub(),
					relationStoreOf(["u-mod-a"]),
					divanPending(3),
					requestContext(true),
				),
			),
		),
	);

	it.effect("with the bildirim flag OFF nothing is read or written (dark by default)", () =>
		notifyCaylakEntersDivan({
			authorId: "u-caylak",
			sandboxedAt: new Date("2026-01-01T00:00:00Z"),
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					makeNotificationStub(),
					relationStoreOf(["u-mod-a"]),
					divanDies,
					requestContext(false),
				),
			),
		),
	);

	it.effect("a DYING count read is swallowed — the create caller still succeeds", () =>
		Effect.gen(function* () {
			const exit = yield* notifyCaylakEntersDivan({
				authorId: "u-caylak",
				sandboxedAt: new Date("2026-01-01T00:00:00Z"),
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						makeNotificationStub(),
						relationStoreOf(["u-mod-a"]),
						divanDies,
						requestContext(true),
					),
				),
				Effect.exit,
			);
			assert.strictEqual(exit._tag, "Success");
		}),
	);
});
