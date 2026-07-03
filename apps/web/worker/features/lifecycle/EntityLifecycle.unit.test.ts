/**
 * EntityLifecycle unit coverage (ADR 0082 unit tier — pure, no DB): the removal
 * substrate's type transitions, the column↔lifecycle projection round-trip, the
 * reason codec, and the `Match.tagsExhaustive` reason handlers. The make-invalid-
 * states-unrepresentable guarantees (`Removed` needs its triad; `restore` only on
 * `Removed`) are enforced at compile time — asserted here with `expectTypeOf`.
 */
import {assert, describe, it} from "@effect/vitest";
import {expectTypeOf} from "vitest";
import * as L from "./EntityLifecycle.ts";

const fixedNow = new Date("2026-06-20T12:00:00.000Z");

describe("EntityLifecycle — type transitions", () => {
	it("Live carries no audit; isLive/isRemoved discriminate", () => {
		const live = L.Live();
		assert.strictEqual(live._tag, "Live");
		assert.isTrue(L.isLive(live));
		assert.isFalse(L.isRemoved(live));
	});

	it("remove() builds Removed with the full audit triad (live content ⇒ sandboxedAt null)", () => {
		const removed = L.remove({
			removedAt: fixedNow,
			removedBy: "user-1",
			reason: new L.AuthorDeletion(),
			sandboxedAt: null,
		});
		assert.strictEqual(removed._tag, "Removed");
		assert.isTrue(L.isRemoved(removed));
		assert.strictEqual(removed.removedBy, "user-1");
		assert.strictEqual(removed.removedAt, fixedNow);
		assert.strictEqual(removed.reason._tag, "AuthorDeletion");
		assert.strictEqual(removed.sandboxedAt, null);
	});

	it("restore : Removed → Live for content that was live before removal", () => {
		const removed = L.remove({
			removedAt: fixedNow,
			removedBy: "user-1",
			reason: new L.Moderated({reportId: "rep-9"}),
			sandboxedAt: null,
		});
		const live = L.restore(removed);
		assert.strictEqual(live._tag, "Live");
		assert.isTrue(L.isLive(live));

		// `restore` accepts only `Removed` — restoring a `Live` does not typecheck.
		expectTypeOf(L.restore).parameter(0).toEqualTypeOf<L.Removed>();
		// @ts-expect-error — a `Live` is not assignable to the `Removed` parameter.
		L.restore(L.Live());
	});

	// The çaylak sandbox-escape fix (#1811): a restore is sandbox-faithful — content
	// that was sandboxed before removal returns to Sandboxed, NOT Live, so a
	// delete→restore round-trip can never self-escape a çaylak's content to the
	// always-Live broadcast without a mod's promotion.
	it("restore : Removed → Sandboxed for content sandboxed before removal (#1811)", () => {
		const removed = L.remove({
			removedAt: fixedNow,
			removedBy: "user-1",
			reason: new L.AuthorDeletion(),
			sandboxedAt: fixedNow,
		});
		const back = L.restore(removed);
		assert.strictEqual(back._tag, "Sandboxed");
		assert.isTrue(L.isSandboxed(back));
		assert.isFalse(L.isLive(back));
		if (L.isSandboxed(back)) assert.strictEqual(back.sandboxedAt, fixedNow);
	});

	it("sandboxedAtOf preserves the marker of the pre-removal lifecycle (#1811)", () => {
		assert.strictEqual(L.sandboxedAtOf(L.Live()), null);
		assert.strictEqual(L.sandboxedAtOf(L.sandbox({sandboxedAt: fixedNow})), fixedNow);
		const removed = L.remove({
			removedAt: fixedNow,
			removedBy: "u",
			reason: new L.AuthorDeletion(),
			sandboxedAt: fixedNow,
		});
		assert.strictEqual(L.sandboxedAtOf(removed), fixedNow);
	});

	it("Removed is uninhabitable without its audit triad (compile-time)", () => {
		// @ts-expect-error — missing `removedBy` + `reason` + `sandboxedAt`.
		L.remove({removedAt: fixedNow});
		// @ts-expect-error — missing `reason` + `sandboxedAt`.
		L.remove({removedAt: fixedNow, removedBy: "user-1"});
		// @ts-expect-error — missing `sandboxedAt`.
		L.remove({removedAt: fixedNow, removedBy: "user-1", reason: new L.AuthorDeletion()});
		assert.ok(true);
	});
});

describe("EntityLifecycle — column projection round-trip", () => {
	it("removedAt + sandboxedAt both null ⇒ Live", () => {
		const lifecycle = L.fromColumns({
			removedAt: null,
			removedBy: null,
			removedReason: null,
			sandboxedAt: null,
		});
		assert.isTrue(L.isLive(lifecycle));
	});

	it("a removed row projects to Removed with its decoded reason", () => {
		const lifecycle = L.fromColumns({
			removedAt: fixedNow,
			removedBy: "user-1",
			removedReason: '{"_tag":"Moderated","reportId":"rep-9"}',
			sandboxedAt: null,
		});
		assert.isTrue(L.isRemoved(lifecycle));
		if (L.isRemoved(lifecycle)) {
			assert.strictEqual(lifecycle.removedBy, "user-1");
			assert.strictEqual(lifecycle.reason._tag, "Moderated");
			assert.strictEqual(L.reasonReportId(lifecycle.reason), "rep-9");
		}
	});

	it("toColumns(remove(...)) round-trips back through fromColumns", () => {
		const removed = L.remove({
			removedAt: fixedNow,
			removedBy: "user-1",
			reason: new L.Anonymized(),
			sandboxedAt: null,
		});
		const cols = L.toColumns(removed);
		assert.strictEqual(cols.removedBy, "user-1");
		assert.strictEqual(cols.removedReason, '{"_tag":"Anonymized"}');
		assert.strictEqual(cols.sandboxedAt, null);
		const back = L.fromColumns(cols);
		assert.isTrue(L.isRemoved(back));
		if (L.isRemoved(back)) assert.strictEqual(back.reason._tag, "Anonymized");
	});

	it("toColumns(restore(removed)) clears the whole triad + sandbox for live-before-removal", () => {
		const removed = L.remove({
			removedAt: fixedNow,
			removedBy: "user-1",
			reason: new L.AuthorDeletion(),
			sandboxedAt: null,
		});
		const cols = L.toColumns(L.restore(removed));
		assert.deepStrictEqual(cols, {
			removedAt: null,
			removedBy: null,
			removedReason: null,
			sandboxedAt: null,
		});
	});

	// #1811: a sandboxed-then-removed row PRESERVES its `sandboxedAt` through the
	// Removed columns (so restore can round-trip it), and restore persists it back as
	// a Sandboxed row — never a Live row with the marker cleared.
	it("toColumns(remove(...)) preserves the pre-removal sandboxedAt column (#1811)", () => {
		const removed = L.remove({
			removedAt: fixedNow,
			removedBy: "user-1",
			reason: new L.AuthorDeletion(),
			sandboxedAt: fixedNow,
		});
		const cols = L.toColumns(removed);
		assert.strictEqual(cols.removedAt, fixedNow);
		assert.strictEqual(cols.sandboxedAt, fixedNow);
		// A removed-AND-sandboxed row still PROJECTS to Removed (removal precedence)…
		const back = L.fromColumns(cols);
		assert.isTrue(L.isRemoved(back));
		// …but carries the marker, so restore recovers the sandbox rather than Live.
		if (L.isRemoved(back)) {
			assert.strictEqual(back.sandboxedAt, fixedNow);
			const restoredCols = L.toColumns(L.restore(back));
			assert.deepStrictEqual(restoredCols, {
				removedAt: null,
				removedBy: null,
				removedReason: null,
				sandboxedAt: fixedNow,
			});
		}
	});

	it("a corrupt half-removal (removedAt set, audit missing) is rejected loudly", () => {
		assert.throws(
			() =>
				L.fromColumns({
					removedAt: fixedNow,
					removedBy: null,
					removedReason: null,
					sandboxedAt: null,
				}),
			/corrupt half-removal/,
		);
	});
});

describe("EntityLifecycle — sandbox (#1205)", () => {
	it("sandboxedAt set (removedAt null) ⇒ Sandboxed", () => {
		const lifecycle = L.fromColumns({
			removedAt: null,
			removedBy: null,
			removedReason: null,
			sandboxedAt: fixedNow,
		});
		assert.isTrue(L.isSandboxed(lifecycle));
		assert.isFalse(L.isLive(lifecycle));
		assert.isFalse(L.isRemoved(lifecycle));
		if (L.isSandboxed(lifecycle)) assert.strictEqual(lifecycle.sandboxedAt, fixedNow);
	});

	it("removal takes precedence over sandbox in the projection, carrying the marker (#1811)", () => {
		const lifecycle = L.fromColumns({
			removedAt: fixedNow,
			removedBy: "user-1",
			removedReason: '{"_tag":"AuthorDeletion"}',
			sandboxedAt: fixedNow,
		});
		// A removed-AND-sandboxed row reads as Removed (the removal is the live fact)…
		assert.isTrue(L.isRemoved(lifecycle));
		// …but the pre-removal sandbox marker is carried, not dropped — so restore
		// round-trips it back to the sandbox (the çaylak-escape fix).
		if (L.isRemoved(lifecycle)) assert.strictEqual(lifecycle.sandboxedAt, fixedNow);
	});

	it("toColumns(sandbox(...)) writes only sandboxedAt; never sandboxed-AND-removed", () => {
		const cols = L.toColumns(L.sandbox({sandboxedAt: fixedNow}));
		assert.deepStrictEqual(cols, {
			removedAt: null,
			removedBy: null,
			removedReason: null,
			sandboxedAt: fixedNow,
		});
	});

	it("promote : Sandboxed → Live, and is only defined on Sandboxed", () => {
		const sandboxed = L.sandbox({sandboxedAt: fixedNow});
		assert.isTrue(L.isLive(L.promote(sandboxed)));
		expectTypeOf(L.promote).parameter(0).toEqualTypeOf<L.Sandboxed>();
		// @ts-expect-error — a `Live` is not assignable to the `Sandboxed` parameter.
		L.promote(L.Live());
	});
});

describe("EntityLifecycle — exhaustive reason handling", () => {
	it("reasonLabel handles every reason (Turkish product copy)", () => {
		assert.strictEqual(L.reasonLabel(new L.AuthorDeletion()), "yazar tarafından silindi");
		assert.strictEqual(L.reasonLabel(new L.Anonymized()), "hesap silindiği için kaldırıldı");
		assert.strictEqual(
			L.reasonLabel(new L.Moderated({reportId: "rep-1"})),
			"moderasyon kararıyla kaldırıldı",
		);
	});

	it("reasonReportId extracts only the Moderated report id", () => {
		assert.strictEqual(L.reasonReportId(new L.AuthorDeletion()), null);
		assert.strictEqual(L.reasonReportId(new L.Anonymized()), null);
		assert.strictEqual(L.reasonReportId(new L.Moderated({reportId: "rep-7"})), "rep-7");
	});
});
