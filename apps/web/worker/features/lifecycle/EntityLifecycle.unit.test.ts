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

	it("remove() builds Removed with the full audit triad", () => {
		const removed = L.remove({
			removedAt: fixedNow,
			removedBy: "user-1",
			reason: new L.AuthorDeletion(),
		});
		assert.strictEqual(removed._tag, "Removed");
		assert.isTrue(L.isRemoved(removed));
		assert.strictEqual(removed.removedBy, "user-1");
		assert.strictEqual(removed.removedAt, fixedNow);
		assert.strictEqual(removed.reason._tag, "AuthorDeletion");
	});

	it("restore : Removed → Live, and is only defined on Removed", () => {
		const removed = L.remove({
			removedAt: fixedNow,
			removedBy: "user-1",
			reason: new L.Moderated({reportId: "rep-9"}),
		});
		const live = L.restore(removed);
		assert.strictEqual(live._tag, "Live");
		assert.isTrue(L.isLive(live));

		// `restore` accepts only `Removed` — restoring a `Live` does not typecheck.
		expectTypeOf(L.restore).parameter(0).toEqualTypeOf<L.Removed>();
		// @ts-expect-error — a `Live` is not assignable to the `Removed` parameter.
		L.restore(L.Live());
	});

	it("Removed is uninhabitable without its audit triad (compile-time)", () => {
		// @ts-expect-error — missing `removedBy` + `reason`.
		L.remove({removedAt: fixedNow});
		// @ts-expect-error — missing `reason`.
		L.remove({removedAt: fixedNow, removedBy: "user-1"});
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
		});
		const cols = L.toColumns(removed);
		assert.strictEqual(cols.removedBy, "user-1");
		assert.strictEqual(cols.removedReason, '{"_tag":"Anonymized"}');
		assert.strictEqual(cols.sandboxedAt, null);
		const back = L.fromColumns(cols);
		assert.isTrue(L.isRemoved(back));
		if (L.isRemoved(back)) assert.strictEqual(back.reason._tag, "Anonymized");
	});

	it("toColumns(restore(removed)) clears the whole triad + sandbox (Live persistence)", () => {
		const removed = L.remove({
			removedAt: fixedNow,
			removedBy: "user-1",
			reason: new L.AuthorDeletion(),
		});
		const cols = L.toColumns(L.restore(removed));
		assert.deepStrictEqual(cols, {
			removedAt: null,
			removedBy: null,
			removedReason: null,
			sandboxedAt: null,
		});
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

	it("removal takes precedence over sandbox in the projection (no contradiction)", () => {
		const lifecycle = L.fromColumns({
			removedAt: fixedNow,
			removedBy: "user-1",
			removedReason: '{"_tag":"AuthorDeletion"}',
			sandboxedAt: fixedNow,
		});
		assert.isTrue(L.isRemoved(lifecycle));
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
