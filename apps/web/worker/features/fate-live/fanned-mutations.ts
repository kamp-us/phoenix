/**
 * The fanned-mutation manifest (ADR 0155) — the single, declared source of the
 * fanned/not-fanned decision for every `Fate.mutation` in the worker.
 *
 * A mutation is **fanned** when it writes an entity that lives in a subscribed
 * `/fate/live` connection (`Post` / `Comment` / `Definition`, the entities in the
 * `posts` / `Post.comments` / `Term.definitions` topics) — so after its DB write it
 * MUST publish the invalidation through `WorkerLivePublisher`, or every other
 * client's open live view goes stale until a manual refresh
 * (`.patterns/fate-live-views.md` §Server). Omitting that publish is invisible at the
 * mutation site (the publisher's error channel is `never`, ADR 0039), which is the
 * whole reason for this manifest + the `fanout-guard` CI check.
 *
 * Every `entity.verb` mutation key MUST appear here with a `fanned` flag and a
 * one-line rationale. `pipeline-cli fanout-guard check` enforces two invariants:
 *
 *   1. Drift — the set of keys here EQUALS the set discovered in
 *      `apps/web/worker/features/*.mutations.ts`. A new mutation with no row here
 *      fails the build (the conscious fanned/not decision is forced at authoring).
 *   2. Publish — every `fanned: true` mutation's feature references a
 *      `WorkerLivePublisher` publish. A fanned mutation whose feature omits the
 *      publish fails the build.
 *
 * The rationale field is for the human reader (and the guard's report); the guard
 * keys only on `fanned`.
 */

/** One mutation's fanned classification + the rationale for it. */
export interface FannedMutationEntry {
	/** The `entity.verb` mutation key, exactly as it appears in `Fate.mutation("<key>", …)`. */
	readonly key: string;
	/** True ⇒ writes a fanned entity ⇒ must publish a `/fate/live` invalidation. */
	readonly fanned: boolean;
	/** One line: WHY it does / does not fan (which subscribed connection it touches, or why none). */
	readonly rationale: string;
}

/**
 * The manifest, grouped by feature for readability. The guard flattens it; grouping
 * is cosmetic. Keep each group in sync with its `features/<name>/mutations.ts`.
 */
export const FANNED_MUTATIONS: ReadonlyArray<FannedMutationEntry> = [
	// pano — the post/comment feed. Membership + field changes fan into `posts` and
	// `Post.comments`; drafts are per-user private state in no subscribed connection.
	{
		key: "post.submit",
		fanned: true,
		rationale: "prepends a new Post edge into the `posts` feed connection",
	},
	{
		key: "post.saveDraft",
		fanned: false,
		rationale: "writes the caller's private draft row — no subscribed connection",
	},
	{
		key: "post.discardDraft",
		fanned: false,
		rationale: "clears the caller's private draft row — no subscribed connection",
	},
	{
		key: "post.vote",
		fanned: true,
		rationale: "updates the Post's score/myVote fields other clients subscribe to",
	},
	{
		key: "post.retractVote",
		fanned: true,
		rationale: "updates the Post's score/myVote fields other clients subscribe to",
	},
	{
		key: "post.react",
		fanned: true,
		rationale: "updates the Post's reaction aggregate other clients subscribe to",
	},
	{
		key: "post.save",
		fanned: false,
		rationale:
			"writes the caller's private save relation; the `savedPosts` connection is per-viewer subscribe-only, so a publish onto its login-blind shared topic would leak viewer-private membership — no cross-client fan-out",
	},
	{
		key: "post.unsave",
		fanned: false,
		rationale:
			"clears the caller's private save relation; the `savedPosts` connection is per-viewer subscribe-only, so a publish onto its login-blind shared topic would leak viewer-private membership — no cross-client fan-out",
	},
	{
		key: "post.edit",
		fanned: true,
		rationale: "updates the Post's body/title fields other clients subscribe to",
	},
	{
		key: "post.delete",
		fanned: true,
		rationale: "drops the Post edge from the `posts` feed connection",
	},
	{
		key: "post.restore",
		fanned: true,
		rationale: "re-appends the Post edge into the `posts` feed connection",
	},
	{
		key: "comment.add",
		fanned: true,
		rationale: "appends a new Comment edge into the post's `Post.comments` connection",
	},
	{
		key: "comment.vote",
		fanned: true,
		rationale: "updates the Comment's score/myVote fields other clients subscribe to",
	},
	{
		key: "comment.retractVote",
		fanned: true,
		rationale: "updates the Comment's score/myVote fields other clients subscribe to",
	},
	{
		key: "comment.react",
		fanned: true,
		rationale: "updates the Comment's reaction aggregate other clients subscribe to",
	},
	{
		key: "comment.edit",
		fanned: true,
		rationale: "updates the Comment's body other clients subscribe to",
	},
	{
		key: "comment.delete",
		fanned: true,
		rationale: "tombstones/drops the Comment edge in `Post.comments`",
	},
	{
		key: "comment.restore",
		fanned: true,
		rationale: "re-appends the Comment edge into `Post.comments`",
	},

	// sözlük — terms + definitions. Definition membership + field changes fan into
	// `Term.definitions`.
	{
		key: "definition.add",
		fanned: true,
		rationale: "appends a new Definition edge into the term's `Term.definitions` connection",
	},
	{
		key: "definition.vote",
		fanned: true,
		rationale: "updates the Definition's score/myVote fields other clients subscribe to",
	},
	{
		key: "definition.retractVote",
		fanned: true,
		rationale: "updates the Definition's score/myVote fields other clients subscribe to",
	},
	{
		key: "definition.react",
		fanned: true,
		rationale: "updates the Definition's reaction aggregate other clients subscribe to",
	},
	{
		key: "definition.edit",
		fanned: true,
		rationale: "updates the Definition's body other clients subscribe to",
	},
	{
		key: "definition.delete",
		fanned: true,
		rationale: "drops the Definition edge from `Term.definitions`",
	},
	{
		key: "definition.restore",
		fanned: true,
		rationale: "re-appends the Definition edge into `Term.definitions`",
	},

	// report — moderation. A remove/restore/restoreWave acts on a fanned target
	// (post/comment/definition) and must publish the same invalidation the content
	// features' own delete/restore paths do (#1895). A submit only writes a report row.
	{
		key: "report.submit",
		fanned: false,
		rationale: "writes a report row on the moderation queue — no subscribed content connection",
	},
	{
		key: "report.resolve",
		fanned: true,
		rationale:
			"a `remove` action evicts a fanned Post/Comment/Definition from its subscribed connection",
	},
	{
		key: "report.restore",
		fanned: true,
		rationale: "re-enters a moderator-restored fanned entity into its subscribed connection",
	},
	{
		key: "report.restoreWave",
		fanned: true,
		rationale: "re-enters every fanned entity in the restored wave into its subscribed connection",
	},

	// bildirim — per-user notifications. A read flip touches only the caller's own
	// notification rows, which live in no cross-client subscribed connection.
	{
		key: "bildirim.markRead",
		fanned: false,
		rationale:
			"flips one of the caller's own notification rows — per-user, no subscribed connection",
	},
	{
		key: "bildirim.markAllRead",
		fanned: false,
		rationale: "flips the caller's own unread notifications — per-user, no subscribed connection",
	},

	// divan — the sandboxed proving ground. A vote scores a SANDBOXED item that is
	// deliberately absent from the public feed, so it fans nothing public.
	{
		key: "divan.vote",
		fanned: false,
		rationale:
			"scores a sandboxed çaylak item that is deliberately excluded from the public feed connection",
	},

	// pasaport — identity. Username/vouch/promotion/deletion mutate identity + karma,
	// none of which is a fanned entity in a subscribed content connection.
	{
		key: "user.setUsername",
		fanned: false,
		rationale: "mutates the caller's identity row — no fanned content entity",
	},
	{
		key: "user.setDisplayName",
		fanned: false,
		rationale:
			"write-through of the display name to the caller's `user`/`user_profile` identity rows (#2154) — not a Post/Comment/Definition write; bylines re-resolve live identity on the next read via `stampAuthorIdentity`, and the caller's own `User` view reconciles over the global User pin, so no content connection is fanned",
	},
	{
		key: "account.delete",
		fanned: false,
		rationale: "deletes the caller's account — identity, not a fanned content entity",
	},
	{
		key: "user.promote",
		fanned: false,
		rationale:
			"promotes a çaylak to yazar (karma/tier) — no fanned content entity in a subscribed connection",
	},
	{
		key: "user.vouch",
		fanned: false,
		rationale: "records a kefil vouch edge — no fanned content entity",
	},
	{
		key: "user.withdrawVouch",
		fanned: false,
		rationale: "withdraws a kefil vouch edge — no fanned content entity",
	},
	{
		key: "user.banUser",
		fanned: false,
		rationale:
			"appends an audited ban event on the identity surface (enforced at the session boundary) — no Post/Comment/Definition in a subscribed content connection",
	},
	{
		key: "user.unbanUser",
		fanned: false,
		rationale: "appends an audited unban event on the identity surface — no fanned content entity",
	},

	// mecmua — long-form posts (#2497, epic #2467). mecmua Post does NOT yet live in a
	// subscribed `/fate/live` connection (no mecmua root is wired), so neither write fans;
	// if a mecmua mutation is later classified fanned it must publish via `WorkerLivePublisher`.
	{
		key: "mecmua.publish",
		fanned: false,
		rationale:
			"stamps publishedAt on a mecmua post — mecmua Post is in no subscribed /fate/live connection yet (#2463)",
	},
	{
		key: "mecmua.saveDraft",
		fanned: false,
		rationale: "writes the caller's private mecmua draft row — no subscribed connection",
	},
	{
		key: "mecmua.subscribe",
		fanned: false,
		rationale:
			"writes the caller's private reader→author subscription edge; the `mecmuaFeed` connection is per-viewer subscribe-only, so a publish onto its login-blind shared topic would leak viewer-private membership — no cross-client fan-out",
	},
	{
		key: "mecmua.unsubscribe",
		fanned: false,
		rationale:
			"clears the caller's private reader→author subscription edge; per-viewer `mecmuaFeed` connection, same no-leak rationale as `mecmua.subscribe`",
	},
];
