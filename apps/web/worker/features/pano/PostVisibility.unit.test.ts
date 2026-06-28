/**
 * The pano post-visibility matrix (ADR 0113) — the seam test that lets the Phase-3
 * per-surface predicates be deleted on migration without each re-testing the rule.
 * Asserts `postVisibleTo` over the full cross-product the acceptance criteria name:
 * four content states {Live, Sandboxed, Removed, Draft-private-to-author} × four viewer
 * kinds {anonymous, author, other-member, moderator}.
 *
 * The load-bearing cell that distinguishes draft from sandbox: a moderator sees a
 * Sandboxed post (sandbox review) but NOT a Draft — an unpublished draft is author-only
 * with no moderator exemption. The matrix pins both.
 */
import {assert, describe, it} from "@effect/vitest";
import * as L from "../lifecycle/EntityLifecycle.ts";
import {postVisibleTo, postVisibleWhere, publicLivePostWhere} from "./PostVisibility.ts";

const at = new Date("2026-06-27T00:00:00.000Z");
const AUTHOR = "the-author";
const OTHER = "someone-else";

const live = L.Live();
const sandboxed = L.sandbox({sandboxedAt: at});
const removed = L.remove({removedAt: at, removedBy: "mod-1", reason: new L.AuthorDeletion()});

const viewers = {
	anonymous: L.anonymousViewer,
	author: {viewerId: AUTHOR, canSeeSandboxed: false},
	otherMember: {viewerId: OTHER, canSeeSandboxed: false},
	moderator: {viewerId: "a-mod", canSeeSandboxed: true},
} satisfies Record<string, L.SandboxViewer>;

// Each cell is the expected `postVisibleTo(state.lifecycle, state.isDraft, AUTHOR, viewer)`
// — content authored by AUTHOR, viewed by each viewer kind.
const matrix: Record<
	string,
	{lifecycle: L.EntityLifecycle; isDraft: boolean; expect: Record<keyof typeof viewers, boolean>}
> = {
	Live: {
		lifecycle: live,
		isDraft: false,
		expect: {anonymous: true, author: true, otherMember: true, moderator: true},
	},
	Sandboxed: {
		lifecycle: sandboxed,
		isDraft: false,
		// author + moderator (sandbox review); hidden from anonymous + other members.
		expect: {anonymous: false, author: true, otherMember: false, moderator: true},
	},
	Removed: {
		lifecycle: removed,
		isDraft: false,
		expect: {anonymous: false, author: false, otherMember: false, moderator: false},
	},
	DraftPrivateToAuthor: {
		lifecycle: live,
		isDraft: true,
		// author ONLY — NO moderator exemption (the cell that separates draft from sandbox).
		expect: {anonymous: false, author: true, otherMember: false, moderator: false},
	},
};

describe("postVisibleTo — the four-state × four-viewer visibility matrix", () => {
	for (const [stateName, {lifecycle, isDraft, expect}] of Object.entries(matrix)) {
		for (const [viewerName, viewer] of Object.entries(viewers)) {
			const want = expect[viewerName as keyof typeof viewers];
			it(`${stateName} content is ${want ? "visible" : "hidden"} to ${viewerName}`, () => {
				assert.strictEqual(postVisibleTo(lifecycle, isDraft, AUTHOR, viewer), want);
			});
		}
	}

	it("a moderator CANNOT see a draft but CAN see a sandboxed post (draft ≠ sandbox)", () => {
		assert.isFalse(postVisibleTo(live, true, AUTHOR, viewers.moderator));
		assert.isTrue(postVisibleTo(sandboxed, false, AUTHOR, viewers.moderator));
	});

	it("the author sees their OWN draft but not ANOTHER author's draft", () => {
		assert.isTrue(postVisibleTo(live, true, AUTHOR, viewers.author));
		assert.isFalse(postVisibleTo(live, true, OTHER, viewers.author));
	});
});

describe("postVisibleWhere — the SQL mirror's predicate shape", () => {
	const cols = {sandboxedAt: {} as never, authorId: {} as never, isDraft: {} as never};

	it("a moderator still gets a restricting predicate (drafts gated even for mods)", () => {
		// sandbox arm is undefined for a mod, but the draft arm is not — so the
		// composition is defined, proving mods do not see drafts via this seam.
		assert.isDefined(postVisibleWhere(cols, viewers.moderator));
	});

	it("a signed-in member gets a restricting predicate", () => {
		assert.isDefined(postVisibleWhere(cols, viewers.author));
	});

	it("an anonymous viewer gets a restricting predicate", () => {
		assert.isDefined(postVisibleWhere(cols, viewers.anonymous));
	});
});

describe("publicLivePostWhere — the post-aware public-live aggregate", () => {
	const cols = {
		sandboxedAt: {} as never,
		authorId: {} as never,
		removedAt: {} as never,
		isDraft: {} as never,
	};

	it("is defined for every viewer kind (removal guard always restricts)", () => {
		for (const viewer of Object.values(viewers)) {
			assert.isDefined(publicLivePostWhere(cols, viewer));
		}
	});
});
