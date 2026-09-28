/**
 * The pano post-visibility matrix (ADR 0113) — the seam test that lets the per-surface
 * predicates be deleted on migration without each re-testing the rule.
 *
 * The load-bearing cell that distinguishes draft from sandbox: a moderator sees a
 * Sandboxed post but NOT a Draft — an unpublished draft is author-only with no moderator
 * exemption.
 */
import {assert, describe, it} from "@effect/vitest";
import * as L from "../lifecycle/EntityLifecycle.ts";
import {postVisibleTo} from "./PostVisibility.ts";

const at = new Date("2026-06-27T00:00:00.000Z");
const AUTHOR = "the-author";
const OTHER = "someone-else";

const live = L.Live();
const sandboxed = L.sandbox({sandboxedAt: at});
const removed = L.remove({
	removedAt: at,
	removedBy: "mod-1",
	reason: new L.AuthorDeletion(),
	sandboxedAt: null,
});

const viewers = {
	anonymous: L.anonymousViewer,
	author: {viewerId: AUTHOR, canSeeSandboxed: false, seesSandboxedInPlace: false},
	otherMember: {viewerId: OTHER, canSeeSandboxed: false, seesSandboxedInPlace: false},
	moderator: {viewerId: "a-mod", canSeeSandboxed: true, seesSandboxedInPlace: false},
} satisfies Record<string, L.SandboxViewer>;

// Content is always authored by AUTHOR; each cell is the expectation per viewer kind.
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
		// Author ONLY — no moderator exemption; this is the cell separating draft from sandbox.
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
});
