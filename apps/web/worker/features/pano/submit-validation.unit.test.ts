/**
 * Pano submit-validation WIRING coverage (ADR 0082) — the post/draft/comment
 * input checks driven THROUGH their only caller, the mutation, not the extracted
 * helper in isolation.
 *
 * `submitPost` / `saveDraft` / `addComment` run their validators BEFORE any DB
 * read, so a throwing `Drizzle` (every `run`/`batch` `die`s) is the "no DB call"
 * proof: a typed validation failure surfacing instead of a defect means the gate
 * fired before the seam was reached. A refactor that reorders a `validate*` call
 * after a DB read, or drops it, would die (or succeed) here instead of
 * rejecting — closing the interface-as-test-surface hole the
 * `pasaport/username-validation.unit.test.ts` pattern already closes.
 *
 * `editPost` is the one mutation whose validation runs AFTER its existence/auth
 * read (it validates against the persisted row), so its wiring is proven over a
 * scripted `Drizzle` that returns an owned post on the read and `die`s on the
 * write batch: the validator must reject before that write.
 *
 * The DB-state-dependent rejections of the same mutations (`POST_NOT_FOUND`,
 * `PARENT_NOT_FOUND`, `UNAUTHORIZED`) stay on real D1 in
 * `tests/integration/pano-*.test.ts` — those are only-wrong-if-the-DB-differs.
 * The validator helpers are module-private; this file reaches them only through
 * the mutation, never by direct import.
 */

import {it} from "@effect/vitest";
import {Cause, type Context, Effect, Exit, Layer} from "effect";
import {assert} from "vitest";
import {Drizzle, type DrizzleAccess, type DrizzleDb} from "../../db/Drizzle.ts";
import {Reaction} from "../reaction/Reaction.ts";
import {Vote} from "../vote/Vote.ts";
import {Bookmark} from "./Bookmark.ts";
import {COMMENT_BODY_MAX, Pano, PanoLive, POST_BODY_MAX, POST_TITLE_MAX} from "./Pano.ts";

// Every DB call dies, so any path that reaches the seam fails the test: the
// validation gate short-circuits before any read/write, and running to a typed
// failure against this access is the "no DB call" proof.
const throwingAccess: DrizzleAccess = {
	run: () => Effect.die(new Error("a pano mutation read the DB on a path that must short-circuit")),
	batch: () =>
		Effect.die(new Error("a pano mutation wrote a batch on a path that must short-circuit")),
};

// `editPost` validates AFTER its existence/auth read, so its wiring is proven
// over a `run` that resolves an owned post once and dies on any later write: the
// title/body gate must reject before the write batch is ever built.
const editPostReadThenDieAccess = (postRow: unknown): DrizzleAccess => {
	const state = {firstRunDone: false};
	return {
		run: <A>(fn: (db: DrizzleDb) => Promise<A>) => {
			void fn;
			if (!state.firstRunDone) {
				state.firstRunDone = true;
				return Effect.succeed(postRow as A);
			}
			return Effect.die(new Error("editPost wrote past the validation gate it must short-circuit"));
		},
		batch: () =>
			Effect.die(new Error("editPost wrote a batch past the gate it must short-circuit")),
	};
};

// Pano's validation gate touches neither Vote nor Bookmark (they're consulted
// only on the read/aggregate paths), so never-cast inert instances satisfy the
// layer's dependency types without a real implementation.
const inertVote = Layer.succeed(Vote, {} as Context.Service.Shape<typeof Vote>);
const inertBookmark = Layer.succeed(Bookmark, {} as Context.Service.Shape<typeof Bookmark>);
const inertReaction = Layer.succeed(Reaction, {} as Context.Service.Shape<typeof Reaction>);

const panoLayer = (access: DrizzleAccess) =>
	PanoLive.pipe(
		Layer.provide(Layer.succeed(Drizzle, access)),
		Layer.provide(inertVote),
		Layer.provide(inertBookmark),
		Layer.provide(inertReaction),
	);

const expectTag = (exit: Exit.Exit<unknown, unknown>, tag: string) => {
	assert.isTrue(Exit.isFailure(exit), "expected the mutation to fail at the validation gate");
	if (Exit.isFailure(exit)) {
		const error = Cause.findErrorOption(exit.cause);
		assert.isTrue(
			error._tag === "Some",
			"expected a typed validation failure, not a die (a DB call)",
		);
		if (error._tag === "Some") {
			assert.strictEqual((error.value as {_tag: string})._tag, tag);
		}
	}
};

const ownerId = "u1";

const baseSubmit = {
	title: "geçerli başlık",
	body: "gövde" as string | undefined,
	url: undefined as string | undefined,
	tags: [{kind: "soru"}] as ReadonlyArray<{kind: string; label?: string}>,
	authorId: ownerId,
	authorName: "umut",
};

const runSubmit = (overrides: Partial<typeof baseSubmit>) =>
	Effect.gen(function* () {
		const pano = yield* Pano;
		return yield* pano.submitPost({...baseSubmit, ...overrides}).pipe(Effect.exit);
	}).pipe(Effect.provide(panoLayer(throwingAccess)));

it.effect("submitPost: an empty title rejects with TitleRequired before any DB call", () =>
	Effect.gen(function* () {
		expectTag(yield* runSubmit({title: "   "}), "pano/TitleRequired");
	}),
);

it.effect("submitPost: an over-long title rejects with TitleTooLong before any DB call", () =>
	Effect.gen(function* () {
		expectTag(yield* runSubmit({title: "a".repeat(POST_TITLE_MAX + 1)}), "pano/TitleTooLong");
	}),
);

it.effect("submitPost: an over-long body rejects with PostBodyTooLong before any DB call", () =>
	Effect.gen(function* () {
		expectTag(yield* runSubmit({body: "a".repeat(POST_BODY_MAX + 1)}), "pano/PostBodyTooLong");
	}),
);

it.effect("submitPost: a malformed URL rejects with UrlInvalid before any DB call", () =>
	Effect.gen(function* () {
		expectTag(yield* runSubmit({url: "not a url"}), "pano/UrlInvalid");
	}),
);

it.effect("submitPost: an empty tag list rejects with TagsRequired before any DB call", () =>
	Effect.gen(function* () {
		expectTag(yield* runSubmit({tags: []}), "pano/TagsRequired");
	}),
);

it.effect("submitPost: a tag outside the enum rejects with TagInvalid before any DB call", () =>
	Effect.gen(function* () {
		expectTag(yield* runSubmit({tags: [{kind: "nope"}]}), "pano/TagInvalid");
	}),
);

const baseDraft = {
	authorId: ownerId,
	authorName: "umut",
	title: "taslak" as string | undefined,
	body: undefined as string | undefined,
	url: undefined as string | undefined,
	tags: undefined as ReadonlyArray<{kind: string; label?: string}> | undefined,
};

const runDraft = (overrides: Partial<typeof baseDraft>) =>
	Effect.gen(function* () {
		const pano = yield* Pano;
		return yield* pano.saveDraft({...baseDraft, ...overrides}).pipe(Effect.exit);
	}).pipe(Effect.provide(panoLayer(throwingAccess)));

it.effect("saveDraft: an over-long draft title rejects with TitleTooLong before any DB call", () =>
	Effect.gen(function* () {
		expectTag(yield* runDraft({title: "a".repeat(POST_TITLE_MAX + 1)}), "pano/TitleTooLong");
	}),
);

it.effect("saveDraft: an over-long body rejects with PostBodyTooLong before any DB call", () =>
	Effect.gen(function* () {
		expectTag(yield* runDraft({body: "a".repeat(POST_BODY_MAX + 1)}), "pano/PostBodyTooLong");
	}),
);

it.effect("saveDraft: a malformed URL rejects with UrlInvalid before any DB call", () =>
	Effect.gen(function* () {
		expectTag(yield* runDraft({url: "not a url"}), "pano/UrlInvalid");
	}),
);

it.effect("saveDraft: a tag outside the enum rejects with TagInvalid before any DB call", () =>
	Effect.gen(function* () {
		expectTag(yield* runDraft({tags: [{kind: "nope"}]}), "pano/TagInvalid");
	}),
);

const baseComment = {
	postId: "post_1",
	authorId: ownerId,
	authorName: "umut",
	body: "yorum",
	parentId: null as string | null,
};

const runComment = (overrides: Partial<typeof baseComment>) =>
	Effect.gen(function* () {
		const pano = yield* Pano;
		return yield* pano.addComment({...baseComment, ...overrides}).pipe(Effect.exit);
	}).pipe(Effect.provide(panoLayer(throwingAccess)));

it.effect(
	"addComment: a whitespace-only body rejects with CommentBodyRequired before any DB call",
	() =>
		Effect.gen(function* () {
			expectTag(yield* runComment({body: "   "}), "pano/CommentBodyRequired");
		}),
);

it.effect("addComment: an over-long body rejects with CommentBodyTooLong before any DB call", () =>
	Effect.gen(function* () {
		expectTag(
			yield* runComment({body: "a".repeat(COMMENT_BODY_MAX + 1)}),
			"pano/CommentBodyTooLong",
		);
	}),
);

// An owned, live post the existence/auth read resolves before editPost reaches
// its validation gate — only the columns the mutation reads need be present.
const ownedPostRow = {
	id: "post_1",
	title: "eski başlık",
	body: "eski gövde",
	bodyExcerpt: "eski gövde",
	authorId: ownerId,
	authorName: "umut",
	score: 0,
	createdAt: new Date(0),
	removedAt: null,
};

const runEdit = (overrides: {
	postId?: string;
	actorId?: string;
	title?: string | undefined;
	body?: string | undefined;
}) =>
	Effect.gen(function* () {
		const pano = yield* Pano;
		return yield* pano
			.editPost({postId: "post_1", actorId: ownerId, title: "yeni başlık", ...overrides})
			.pipe(Effect.exit);
	}).pipe(Effect.provide(panoLayer(editPostReadThenDieAccess(ownedPostRow))));

it.effect(
	"editPost: neither title nor body rejects with TitleRequired before the write batch",
	() =>
		Effect.gen(function* () {
			expectTag(yield* runEdit({title: undefined, body: undefined}), "pano/TitleRequired");
		}),
);

it.effect("editPost: an over-long title rejects with TitleTooLong before the write batch", () =>
	Effect.gen(function* () {
		expectTag(yield* runEdit({title: "a".repeat(POST_TITLE_MAX + 1)}), "pano/TitleTooLong");
	}),
);

it.effect("editPost: an over-long body rejects with PostBodyTooLong before the write batch", () =>
	Effect.gen(function* () {
		expectTag(
			yield* runEdit({title: undefined, body: "a".repeat(POST_BODY_MAX + 1)}),
			"pano/PostBodyTooLong",
		);
	}),
);
