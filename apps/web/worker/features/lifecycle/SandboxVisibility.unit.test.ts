/**
 * The çaylak-sandbox visibility matrix (#1205) — the core deliverable (ADR 0082
 * unit tier: pure, no DB). Asserts `EntityLifecycle.isVisibleTo` over the full
 * cross-product the acceptance criteria name: every viewer kind
 * {çaylak-author, yazar, moderator, other-member, anonymous, opted-in in-place viewer}
 * × content ownership {own, others'} × lifecycle {Live, Sandboxed, Removed}.
 *
 * The viewer rank (çaylak vs yazar) carries NO sandbox-visibility weight on its
 * own — only `canSeeSandboxed` (moderator), `seesSandboxedInPlace` (the #6423 opt-in)
 * and authorship do. A plain yazar is modeled here exactly as any non-moderator member
 * to prove that: a yazar gains no view into another member's sandbox just by being a
 * yazar — the opt-in row is what widens it, and it still sees no `Removed` content.
 */
import {assert, describe, it} from "@effect/vitest";
import type {SQL} from "drizzle-orm";
import {integer, SQLiteDialect, sqliteTable, text} from "drizzle-orm/sqlite-core";
import * as L from "./EntityLifecycle.ts";
import {
	ownSandboxed,
	publicLiveWhere,
	sandboxArm,
	sandboxBacklogWhere,
	sandboxedInPlace,
	sandboxVisibleWhere,
} from "./SandboxVisibility.ts";

const at = new Date("2026-06-25T00:00:00.000Z");
const AUTHOR = "caylak-author";
const OTHER = "someone-else";

// A throwaway drizzle table carrying exactly the lifecycle columns the predicates read,
// so the SQL-shape assertions below render against stable column names.
const content = sqliteTable("content", {
	id: text("id").primaryKey(),
	authorId: text("author_id").notNull(),
	sandboxedAt: integer("sandboxed_at"),
	removedAt: integer("removed_at"),
});

const dialect = new SQLiteDialect();

const render = (predicate: SQL | undefined): {sql: string; params: unknown[]} => {
	if (predicate === undefined) throw new Error("expected a predicate, got undefined");
	const {sql, params} = dialect.sqlToQuery(predicate);
	return {sql, params};
};

const table = {sandboxedAt: content.sandboxedAt, authorId: content.authorId};

const live = L.Live();
const sandboxed = L.sandbox({sandboxedAt: at});
const removed = L.remove({
	removedAt: at,
	removedBy: "mod-1",
	reason: new L.AuthorDeletion(),
	sandboxedAt: null,
});

// The six viewer kinds. çaylak-author, yazar and otherMember are all non-moderator
// members; the matrix proves visibility turns on moderator-authority, the #6423 opt-in
// and authorship — never on rank alone.
const viewers = {
	caylakAuthor: {viewerId: AUTHOR, canSeeSandboxed: false, seesSandboxedInPlace: false},
	yazar: {viewerId: "a-yazar", canSeeSandboxed: false, seesSandboxedInPlace: false},
	moderator: {viewerId: "a-mod", canSeeSandboxed: true, seesSandboxedInPlace: false},
	otherMember: {viewerId: OTHER, canSeeSandboxed: false, seesSandboxedInPlace: false},
	anonymous: L.anonymousViewer,
	inPlaceYazar: {viewerId: "opted-in-yazar", canSeeSandboxed: false, seesSandboxedInPlace: true},
} satisfies Record<string, L.SandboxViewer>;

describe("sandbox visibility matrix — Live content is public to everyone", () => {
	for (const [name, viewer] of Object.entries(viewers)) {
		it(`${name} sees Live content (own + others')`, () => {
			assert.isTrue(L.isVisibleTo(live, AUTHOR, viewer));
			assert.isTrue(L.isVisibleTo(live, OTHER, viewer));
		});
	}
});

describe("sandbox visibility matrix — Removed content is hidden from everyone (content reads)", () => {
	for (const [name, viewer] of Object.entries(viewers)) {
		it(`${name} never sees Removed content in a content read`, () => {
			assert.isFalse(L.isVisibleTo(removed, AUTHOR, viewer));
			assert.isFalse(L.isVisibleTo(removed, OTHER, viewer));
		});
	}
});

describe("sandbox visibility matrix — Sandboxed content (the #1205 rule)", () => {
	it("the çaylak author sees their OWN sandboxed content", () => {
		assert.isTrue(L.isVisibleTo(sandboxed, AUTHOR, viewers.caylakAuthor));
	});

	it("the çaylak author does NOT see ANOTHER member's sandboxed content", () => {
		assert.isFalse(L.isVisibleTo(sandboxed, OTHER, viewers.caylakAuthor));
	});

	it("a moderator sees ALL sandboxed content (own + others')", () => {
		assert.isTrue(L.isVisibleTo(sandboxed, AUTHOR, viewers.moderator));
		assert.isTrue(L.isVisibleTo(sandboxed, OTHER, viewers.moderator));
	});

	it("a yazar (non-moderator) does NOT see another member's sandboxed content", () => {
		assert.isFalse(L.isVisibleTo(sandboxed, AUTHOR, viewers.yazar));
		assert.isFalse(L.isVisibleTo(sandboxed, OTHER, viewers.yazar));
	});

	it("another member does NOT see someone's sandboxed content", () => {
		assert.isFalse(L.isVisibleTo(sandboxed, AUTHOR, viewers.otherMember));
	});

	it("an anonymous/public viewer NEVER sees sandboxed content", () => {
		assert.isFalse(L.isVisibleTo(sandboxed, AUTHOR, viewers.anonymous));
		assert.isFalse(L.isVisibleTo(sandboxed, OTHER, viewers.anonymous));
	});

	it("an opted-in in-place viewer sees sandboxed content authored by ANYONE (#6423)", () => {
		assert.isTrue(L.isVisibleTo(sandboxed, AUTHOR, viewers.inPlaceYazar));
		assert.isTrue(L.isVisibleTo(sandboxed, OTHER, viewers.inPlaceYazar));
	});

	it("an opted-in in-place viewer still sees NO Removed content", () => {
		assert.isFalse(L.isVisibleTo(removed, AUTHOR, viewers.inPlaceYazar));
		assert.isFalse(L.isVisibleTo(removed, OTHER, viewers.inPlaceYazar));
	});
});

describe("sandboxArm — the exported reusable per-tag arm builder (#2031)", () => {
	const cols = {sandboxedAt: {} as never, authorId: {} as never};

	it("Live contributes an arm (the `sandboxed_at IS NULL` public base)", () => {
		assert.isDefined(sandboxArm("Live", cols, viewers.anonymous));
	});

	it("Removed contributes no arm — undefined (the caller's removal guard filters it)", () => {
		assert.isUndefined(sandboxArm("Removed", cols, viewers.caylakAuthor));
	});

	it("Sandboxed contributes the author arm for a signed-in viewer", () => {
		assert.isDefined(sandboxArm("Sandboxed", cols, viewers.caylakAuthor));
	});

	it("Sandboxed contributes no arm for an anonymous viewer (no author to match)", () => {
		assert.isUndefined(sandboxArm("Sandboxed", cols, viewers.anonymous));
	});

	it("Sandboxed contributes an author-blind arm for an in-place viewer (#6423)", () => {
		const arm = sandboxArm("Sandboxed", table, viewers.inPlaceYazar);
		assert.isDefined(arm);
		assert.deepStrictEqual(render(arm), {
			sql: '("content"."sandboxed_at" is not null)',
			params: [],
		});
	});
});

describe("sandboxVisibleWhere — the SQL predicate mirrors the decision shape", () => {
	const cols = {sandboxedAt: {} as never, authorId: {} as never};

	it("a moderator gets no restriction (undefined ⇒ full set visible)", () => {
		assert.strictEqual(sandboxVisibleWhere(cols, viewers.moderator), undefined);
	});

	it("a signed-in member gets a restricting predicate (own + public)", () => {
		assert.isDefined(sandboxVisibleWhere(cols, viewers.caylakAuthor));
	});

	it("an anonymous viewer gets a restricting predicate (public only)", () => {
		assert.isDefined(sandboxVisibleWhere(cols, viewers.anonymous));
	});

	// The widening rides `seesSandboxedInPlace`, so the moderator short-circuit stays
	// the only path to "no restriction" — an in-place viewer is still filtered, just
	// on the sandbox dimension rather than on authorship.
	it("an in-place viewer gets a restricting predicate, not the moderator undefined", () => {
		assert.isDefined(sandboxVisibleWhere(cols, viewers.inPlaceYazar));
	});
});

/**
 * The containment proof for #6421's flag (#6423 AC): with the flag off nothing resolves
 * `seesSandboxedInPlace: true`, so every viewer shape must render byte-for-byte the SQL
 * this predicate rendered before the third class existed. The goldens below are that
 * pre-#6423 output, so any drift in the untouched arms fails here rather than in
 * production behind a dark flag.
 */
describe("sandboxVisibleWhere — flag-off SQL is byte-for-byte unchanged (#6423)", () => {
	const goldens: ReadonlyArray<
		[name: string, viewer: L.SandboxViewer, expected: {sql: string; params: unknown[]} | null]
	> = [
		["anonymous", viewers.anonymous, {sql: '("content"."sandboxed_at" is null)', params: []}],
		[
			"signed-in member",
			viewers.otherMember,
			{
				sql: '((("content"."sandboxed_at" is null)) or ("content"."author_id" = ?))',
				params: [OTHER],
			},
		],
		["moderator", viewers.moderator, null],
	];

	for (const [name, viewer, expected] of goldens) {
		it(`${name} renders the pre-#6423 predicate exactly`, () => {
			const where = sandboxVisibleWhere(table, viewer);
			assert.deepStrictEqual(where === undefined ? null : render(where), expected);
		});
	}
});

describe("sandboxBacklogWhere — the moderator queue is blind to the in-place class (#6423)", () => {
	const backlogCols = {
		sandboxedAt: content.sandboxedAt,
		removedAt: content.removedAt,
		authorId: content.authorId,
	};

	// The backlog predicate takes no viewer at all — it is scoped by author id, if at
	// all. Rendering it for the in-place viewer's id and an ordinary member's id proves
	// the opt-in buys no backlog access: the two differ only by the id they were handed.
	it("an in-place viewer's backlog predicate matches an ordinary member's", () => {
		const inPlace = sandboxBacklogWhere(backlogCols, {authorId: "opted-in-yazar"});
		const member = sandboxBacklogWhere(backlogCols, {authorId: OTHER});
		assert.isDefined(inPlace);
		assert.isDefined(member);
		assert.strictEqual(render(inPlace).sql, render(member).sql);
		assert.deepStrictEqual(render(inPlace).params, ["opted-in-yazar"]);
	});

	it("the unscoped backlog predicate is the same for every viewer class", () => {
		assert.deepStrictEqual(render(sandboxBacklogWhere(backlogCols)), {
			sql: '((("content"."sandboxed_at" is not null)) and (("content"."removed_at" is null)))',
			params: [],
		});
	});
});

describe("ownSandboxed — the owner-scoped in-review flag (never leaks review state)", () => {
	const ownSandboxedRecord = {sandboxedAt: at, authorId: AUTHOR};
	const ownLiveRecord = {sandboxedAt: null, authorId: AUTHOR};

	it("the author of a still-sandboxed row reads true (their own in-review signal)", () => {
		assert.isTrue(ownSandboxed(ownSandboxedRecord, AUTHOR));
	});

	it("the author of a live (not-sandboxed) row reads false — no signal on public content", () => {
		assert.isFalse(ownSandboxed(ownLiveRecord, AUTHOR));
	});

	it("another member never reads the flag on someone's sandboxed row", () => {
		assert.isFalse(ownSandboxed(ownSandboxedRecord, OTHER));
	});

	it("a moderator (non-author) never reads the flag — owner-only, not moderator-scoped", () => {
		assert.isFalse(ownSandboxed(ownSandboxedRecord, viewers.moderator.viewerId));
	});

	it("an anonymous viewer (null id) never reads the flag", () => {
		assert.isFalse(ownSandboxed(ownSandboxedRecord, null));
	});
});

describe("sandboxedInPlace — the reader-facing çaylak marker (#6425)", () => {
	const sandboxedRow = {sandboxedAt: at, authorId: AUTHOR};
	const liveRow = {sandboxedAt: null, authorId: AUTHOR};

	it("the opted-in in-place reader reads true on someone else's still-sandboxed row", () => {
		assert.isTrue(sandboxedInPlace(sandboxedRow, viewers.inPlaceYazar));
	});

	it("the same reader reads false on a live row — the marker is about hazırlık, not authorship", () => {
		assert.isFalse(sandboxedInPlace(liveRow, viewers.inPlaceYazar));
	});

	// The three shapes acceptance criterion 4 names, plus the moderator: none of them is
	// the audience this marker addresses, so none of them receives it.
	for (const name of ["anonymous", "yazar", "otherMember", "moderator", "caylakAuthor"] as const) {
		it(`${name} never reads the marker on a sandboxed row`, () => {
			assert.isFalse(sandboxedInPlace(sandboxedRow, viewers[name]));
		});
	}

	// `PHOENIX_CAYLAK_VISIBILITY` off is exactly `seesSandboxedInPlace: false` for every
	// viewer (#6423's `inPlaceVisibility` short-circuits on the flag before either store
	// read). Asserted rather than assumed: with the flag down there is no viewer shape,
	// on any row, that can reach the marker.
	it("with the containment flag off, no viewer shape reads the marker on any row", () => {
		for (const viewer of Object.values(viewers)) {
			const flagOff = {...viewer, seesSandboxedInPlace: false};
			assert.isFalse(sandboxedInPlace(sandboxedRow, flagOff));
			assert.isFalse(sandboxedInPlace(liveRow, flagOff));
		}
	});

	// The masked shapes never reach the stamp at all — the read's `sandboxVisibleWhere`
	// drops the row before it is shaped, so "no marker" is the second line of defence and
	// "no row" is the first.
	it("every shape that reads false on a sandboxed row is also denied the row itself", () => {
		for (const [name, viewer] of Object.entries(viewers)) {
			if (sandboxedInPlace(sandboxedRow, viewer)) continue;
			if (name === "caylakAuthor" || name === "moderator") continue;
			assert.isFalse(L.isVisibleTo(sandboxed, AUTHOR, viewer), name);
		}
	});

	it("is disjoint from ownSandboxed — no viewer reads both on one row", () => {
		for (const viewer of Object.values(viewers)) {
			assert.isFalse(
				ownSandboxed(sandboxedRow, viewer.viewerId) && sandboxedInPlace(sandboxedRow, viewer),
			);
		}
	});
});

describe("publicLiveWhere — the removed+sandbox aggregate predicate", () => {
	const cols = {sandboxedAt: {} as never, authorId: {} as never, removedAt: {} as never};

	it("is defined for every viewer kind — the removal guard always restricts", () => {
		// even a moderator (no sandbox restriction) still gets `isNull(removedAt)`, so the
		// aggregate is never undefined — it always excludes removed content.
		for (const viewer of Object.values(viewers)) {
			assert.isDefined(publicLiveWhere(cols, viewer));
		}
	});
});
