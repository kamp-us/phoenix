/**
 * The bildirim target→href fold (#1694) — the tombstone decision asserted with no
 * engine (ADR 0082 T1/T2): a live target maps to its client link, a target absent
 * from the resolved rows (removed / deleted) maps to `null`, and a pre-bootstrap
 * user (no username) tombstones rather than emitting a broken `/u/null`.
 */
import {assert, describe, it} from "@effect/vitest";
import {emptyResolvedTargetRows, foldTargetHrefs, targetRefKey} from "./target.ts";

describe("foldTargetHrefs — live targets map to their client links", () => {
	it("post → /pano/<id>, comment → its post's page, definition → /sozluk/<termSlug>, user → /u/<username>", () => {
		const resolved = foldTargetHrefs(
			[
				{targetKind: "post", targetId: "p1"},
				{targetKind: "comment", targetId: "c1"},
				{targetKind: "definition", targetId: "d1"},
				{targetKind: "user", targetId: "u1"},
			],
			{
				post: [{id: "p1"}],
				comment: [{id: "c1", postId: "p9"}],
				definition: [{id: "d1", termSlug: "kampus"}],
				user: [{id: "u1", username: "umut"}],
			},
		);
		assert.strictEqual(resolved.get(targetRefKey("post", "p1")), "/pano/p1");
		assert.strictEqual(resolved.get(targetRefKey("comment", "c1")), "/pano/p9");
		assert.strictEqual(resolved.get(targetRefKey("definition", "d1")), "/sozluk/kampus");
		assert.strictEqual(resolved.get(targetRefKey("user", "u1")), "/u/umut");
	});
});

describe("foldTargetHrefs — the tombstone decision", () => {
	it("a target absent from the resolved rows (removed content) reads null", () => {
		const resolved = foldTargetHrefs(
			[{targetKind: "post", targetId: "gone"}],
			emptyResolvedTargetRows,
		);
		assert.strictEqual(resolved.get(targetRefKey("post", "gone")), null);
		assert.isTrue(resolved.has(targetRefKey("post", "gone")));
	});

	it("a user without a username (pre-bootstrap) tombstones, never /u/null", () => {
		const resolved = foldTargetHrefs([{targetKind: "user", targetId: "u2"}], {
			...emptyResolvedTargetRows,
			user: [{id: "u2", username: null}],
		});
		assert.strictEqual(resolved.get(targetRefKey("user", "u2")), null);
	});

	it("every requested ref appears in the map (no silent drop)", () => {
		const resolved = foldTargetHrefs(
			[
				{targetKind: "post", targetId: "a"},
				{targetKind: "definition", targetId: "b"},
			],
			emptyResolvedTargetRows,
		);
		assert.strictEqual(resolved.size, 2);
	});
});
