/**
 * The çaylak-sandbox visibility matrix (#1205) — the core deliverable (ADR 0082
 * unit tier: pure, no DB). Asserts `EntityLifecycle.isVisibleTo` over the full
 * cross-product the acceptance criteria name: every viewer kind
 * {çaylak-author, yazar, moderator, other-member, anonymous} × content ownership
 * {own, others'} × lifecycle {Live, Sandboxed, Removed}.
 *
 * The viewer rank (çaylak vs yazar) carries NO sandbox-visibility weight on its
 * own — only `canSeeSandboxed` (moderator) and authorship do. A yazar is modeled
 * here exactly as any non-moderator member to prove that: a yazar gains no view
 * into another member's sandbox just by being a yazar.
 */
import {assert, describe, it} from "@effect/vitest";
import * as L from "./EntityLifecycle.ts";
import {publicLiveWhere, sandboxVisibleWhere} from "./SandboxVisibility.ts";

const at = new Date("2026-06-25T00:00:00.000Z");
const AUTHOR = "caylak-author";
const OTHER = "someone-else";

const live = L.Live();
const sandboxed = L.sandbox({sandboxedAt: at});
const removed = L.remove({
	removedAt: at,
	removedBy: "mod-1",
	reason: new L.AuthorDeletion(),
	sandboxedAt: null,
});

// The five viewer kinds. çaylak-author and yazar are both non-moderator members;
// the matrix proves visibility turns on moderator-authority + authorship, not rank.
const viewers = {
	caylakAuthor: {viewerId: AUTHOR, canSeeSandboxed: false},
	yazar: {viewerId: "a-yazar", canSeeSandboxed: false},
	moderator: {viewerId: "a-mod", canSeeSandboxed: true},
	otherMember: {viewerId: OTHER, canSeeSandboxed: false},
	anonymous: L.anonymousViewer,
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
