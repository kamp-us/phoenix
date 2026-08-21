/**
 * The `Comment` owner-scoped in-review flag on the wire (#4282, the third leg of #2200).
 * The stamping call sites are compile-locked rather than tested here: `rowToCommentRow`
 * takes `viewerId` as a REQUIRED parameter, so a read path cannot forget whose view it is
 * shaping.
 */
import {assert, describe, it} from "@effect/vitest";
import {ownSandboxed} from "../lifecycle/SandboxVisibility.ts";
import {commentViewFields} from "./comment-fields.ts";
import {broadcastComment, toComment} from "./shapers.ts";

const AUTHOR = "user-author";
const OTHER = "user-other";

const commentFields = (over: {sandboxed?: boolean} = {}) => ({
	id: "comm-1",
	parentId: null,
	author: "umut",
	authorId: AUTHOR,
	body: "merhaba",
	score: 0,
	createdAt: new Date(1000),
	...over,
});

describe("ownSandboxed over a comment record — owner-only by construction", () => {
	const sandboxedRecord = {sandboxedAt: new Date(1000), authorId: AUTHOR};
	const liveRecord = {sandboxedAt: null, authorId: AUTHOR};

	it("the author of a still-sandboxed comment reads true", () => {
		assert.strictEqual(ownSandboxed(sandboxedRecord, AUTHOR), true);
	});

	it("another signed-in member reads false, never the author's review state", () => {
		assert.strictEqual(ownSandboxed(sandboxedRecord, OTHER), false);
	});

	// A moderator IS a viewer with an id, and the sandbox read filter admits them to the
	// row — so the flag must stay keyed on authorship, not on visibility, or the mod queue
	// would render every pending comment as the moderator's own in-review content.
	it("a moderator reading someone else's pending comment reads false", () => {
		assert.strictEqual(ownSandboxed(sandboxedRecord, "user-moderator"), false);
	});

	it("an anonymous viewer reads false", () => {
		assert.strictEqual(ownSandboxed(sandboxedRecord, null), false);
	});

	it("a live comment reads false even for its own author", () => {
		assert.strictEqual(ownSandboxed(liveRecord, AUTHOR), false);
	});
});

describe("the Comment wire shape carries sandboxed", () => {
	it("commentViewFields selects it, so CommentView exposes it to the client", () => {
		assert.strictEqual(commentViewFields.sandboxed, true);
	});

	it("toComment passes a stamped flag through", () => {
		assert.strictEqual(toComment(commentFields({sandboxed: true})).sandboxed, true);
	});

	// The safe default, matching `toPost`: a read path that doesn't stamp the flag yields
	// a published-looking node, never an accidental `incelemede` on live content.
	it("toComment defaults an unstamped row to false", () => {
		assert.strictEqual(toComment(commentFields()).sandboxed, false);
	});
});

// #4313: `comment.react` broadcasts a node re-resolved against the REACTOR, so an author
// reacting to their own sandboxed comment would hand their review state to every other
// subscriber of the viewer-blind `Comment` topic.
describe("broadcastComment blanks every viewer-scoped review field at once", () => {
	const ownView = toComment({...commentFields({sandboxed: true}), sandboxedInPlace: true});

	it("an author's own view goes out as neither sandboxed nor sandboxedInPlace", () => {
		const published = broadcastComment(ownView);
		assert.strictEqual(published.sandboxed, false);
		assert.strictEqual(published.sandboxedInPlace, false);
	});

	it("leaves the rest of the node alone", () => {
		assert.deepStrictEqual(broadcastComment(ownView), {
			...ownView,
			sandboxed: false,
			sandboxedInPlace: false,
		});
	});
});
