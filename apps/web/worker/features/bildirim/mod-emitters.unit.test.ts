/**
 * Mod-queue emitter coverage — the decisions wrong-or-right with no database (ADR 0082):
 * moderator resolution + actor self-suppression, the flag containment, the çaylak-entry 0→1
 * gate, and the swallow-at-the-seam guarantee (a DYING dependency cannot fail the caller).
 * The `Notification` / `Divan` / `RelationStore` seams are fail-on-contact stubs with only
 * the exercised method overridden. The emitters swallow every cause, so a silent arm asserts
 * off what the recording stubs touched, never off a death the swallow absorbs.
 *
 * The report-page coalescing (one page per reporter per window, #3641) lives in the digest
 * SQL, proven by `Notification.unit.test.ts`; here only the digest input each call carries.
 */
import {assert, describe, it} from "@effect/vitest";
import {RelationStore} from "@kampus/authz";
import {CurrentUser, LivePublisher} from "@kampus/fate-effect";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {type Duration, Effect, Layer} from "effect";
import {Divan} from "../divan/Divan.ts";
import {noRequestFlagOverrides} from "../fate/resolve-wire.testing.ts";
import {Flags} from "../flagship/Flags.ts";
import {
	CAYLAK_PENDING_KIND,
	modRecipients,
	notifyCaylakEntersDivan,
	notifyReportFiled,
	REPORT_FILED_KIND,
	REPORT_PAGE_WINDOW,
} from "./mod-emitters.ts";
import {makeNotificationStub, makeTouchRecordingNotificationStub} from "./Notification.testing.ts";
import type {NotificationDigestInput, NotificationRecordInput} from "./Notification.ts";

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

// `Notification.record` yields the per-request publisher for the fire-and-forget live
// fan-out; the stub `record` never touches it.
const noopLivePublisher = Layer.succeed(LivePublisher)({
	update: () => Effect.void,
	delete: () => Effect.void,
	invalidate: () => Effect.void,
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

// Exactly `mods` hold the `(moderates, platform)` tuple — the authority model the recipient
// set is resolved from, never a hardcoded list.
const relationStoreOf = (mods: ReadonlyArray<string>): Layer.Layer<RelationStore> =>
	Layer.succeed(RelationStore, {
		has: () => Effect.die(new Error("mod-emitters resolve via subjectsOf, not has")),
		hasSubjects: () =>
			Effect.die(new Error("mod-emitters resolve via subjectsOf, not hasSubjects")),
		subjectsOf: ({relation, object}) =>
			Effect.succeed(new Set(relation === "moderates" && object.type === "platform" ? mods : [])),
	});

const divanPending = (count: number): Layer.Layer<Divan> =>
	Layer.succeed(Divan, {
		roster: () => Effect.die(new Error("Divan.roster not exercised")),
		backlogOf: () => Effect.die(new Error("Divan.backlogOf not exercised")),
		pendingCountOf: () => Effect.succeed(count),
		pendingTotal: () => Effect.die(new Error("Divan.pendingTotal not exercised")),
	});

// Dies on every read, recording what was reached: the emitter swallows the death, so a
// path that must not read asserts `touched` is empty.
const touchRecordingDivan = () => {
	const touched: Array<string> = [];
	const dies = (method: string) => () =>
		Effect.suspend(() => {
			touched.push(method);
			return Effect.die(new Error(`Divan.${method} must not be read`));
		});
	const layer: Layer.Layer<Divan> = Layer.succeed(Divan, {
		roster: dies("roster"),
		backlogOf: dies("backlogOf"),
		pendingCountOf: dies("pendingCountOf"),
		pendingTotal: dies("pendingTotal"),
	});
	return {layer, touched};
};

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

const capturingDigest = () => {
	const calls: Array<{input: NotificationDigestInput; window: Duration.Duration}> = [];
	const layer = makeNotificationStub({
		recordDigest: (input, window) =>
			Effect.sync(() => {
				calls.push({input, window});
				return {digested: false};
			}),
	});
	return {calls, layer};
};

describe("notifyReportFiled — the report-filed mod page", () => {
	it.effect(
		"pages every moderator through the reporter-keyed digest, targeting the reported content",
		() =>
			Effect.gen(function* () {
				const {calls, layer} = capturingDigest();
				yield* notifyReportFiled({
					reporterId: "u-reporter",
					targetKind: "post",
					targetId: "p1",
				}).pipe(
					Effect.provide(
						Layer.mergeAll(layer, relationStoreOf(["u-mod-a", "u-mod-b"]), requestContext(true)),
					),
				);
				assert.strictEqual(calls.length, 2);
				assert.deepStrictEqual(calls[0]?.input, {
					recipientId: "u-mod-a",
					kind: REPORT_FILED_KIND,
					targetKind: "post",
					targetId: "p1",
					actorId: "u-reporter",
				});
				assert.deepStrictEqual(calls[0]?.window, REPORT_PAGE_WINDOW);
				assert.deepStrictEqual(calls[1]?.input.recipientId, "u-mod-b");
			}),
	);

	it.effect(
		"a moderator who files a report is NOT paged about their own report (self-suppression)",
		() =>
			Effect.gen(function* () {
				const {calls, layer} = capturingDigest();
				yield* notifyReportFiled({
					reporterId: "u-mod-a",
					targetKind: "comment",
					targetId: "c1",
				}).pipe(
					Effect.provide(
						Layer.mergeAll(layer, relationStoreOf(["u-mod-a", "u-mod-b"]), requestContext(true)),
					),
				);
				assert.deepStrictEqual(
					calls.map((c) => c.input.recipientId),
					["u-mod-b"],
				);
			}),
	);

	it.effect("no moderators ⇒ the fail-on-contact Notification stub is never touched", () => {
		const notification = makeTouchRecordingNotificationStub();
		return Effect.gen(function* () {
			yield* notifyReportFiled({reporterId: "u-reporter", targetKind: "post", targetId: "p1"});
			assert.deepStrictEqual(notification.touched, []);
		}).pipe(
			Effect.provide(Layer.mergeAll(notification.layer, relationStoreOf([]), requestContext(true))),
		);
	});

	it.effect("with the bildirim flag OFF nothing is read or written (dark by default)", () => {
		const notification = makeTouchRecordingNotificationStub();
		const authorityReads: Array<string> = [];
		const readAuthority = (method: string) => () =>
			Effect.suspend(() => {
				authorityReads.push(method);
				return Effect.die(new Error("flag OFF must not read authority"));
			});
		return Effect.gen(function* () {
			yield* notifyReportFiled({reporterId: "u-reporter", targetKind: "post", targetId: "p1"});
			assert.deepStrictEqual(authorityReads, [], "flag-off must not even resolve moderators");
			assert.deepStrictEqual(notification.touched, []);
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					notification.layer,
					Layer.succeed(RelationStore, {
						has: readAuthority("has"),
						hasSubjects: readAuthority("hasSubjects"),
						subjectsOf: readAuthority("subjectsOf"),
					}),
					requestContext(false),
				),
			),
		);
	});

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
		() => {
			const notification = makeTouchRecordingNotificationStub();
			const divan = touchRecordingDivan();
			return Effect.gen(function* () {
				yield* notifyCaylakEntersDivan({authorId: "u-caylak", sandboxedAt: null});
				assert.deepStrictEqual(divan.touched, []);
				assert.deepStrictEqual(notification.touched, []);
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						notification.layer,
						relationStoreOf(["u-mod-a"]),
						divan.layer,
						requestContext(true),
					),
				),
			);
		},
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

	it.effect("a çaylak's SECOND+ pending item (count > 1) pages nobody — no re-notify", () => {
		const notification = makeTouchRecordingNotificationStub();
		return Effect.gen(function* () {
			yield* notifyCaylakEntersDivan({
				authorId: "u-caylak",
				sandboxedAt: new Date("2026-01-01T00:00:00Z"),
			});
			assert.deepStrictEqual(notification.touched, []);
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					notification.layer,
					relationStoreOf(["u-mod-a"]),
					divanPending(3),
					requestContext(true),
				),
			),
		);
	});

	it.effect("with the bildirim flag OFF nothing is read or written (dark by default)", () => {
		const notification = makeTouchRecordingNotificationStub();
		const divan = touchRecordingDivan();
		return Effect.gen(function* () {
			yield* notifyCaylakEntersDivan({
				authorId: "u-caylak",
				sandboxedAt: new Date("2026-01-01T00:00:00Z"),
			});
			assert.deepStrictEqual(divan.touched, []);
			assert.deepStrictEqual(notification.touched, []);
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					notification.layer,
					relationStoreOf(["u-mod-a"]),
					divan.layer,
					requestContext(false),
				),
			),
		);
	});

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
						touchRecordingDivan().layer,
						requestContext(true),
					),
				),
				Effect.exit,
			);
			assert.strictEqual(exit._tag, "Success");
		}),
	);
});
