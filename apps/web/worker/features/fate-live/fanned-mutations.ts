/**
 * The fanned-mutation manifest — the declared fanned/not decision for every
 * `Fate.mutation` in the worker. See ADR 0155 for the why and
 * `.patterns/fate-live-views.md` §Server for the publish shape.
 *
 * Every `entity.verb` key MUST appear here with a `fanned` flag and a rationale;
 * every `fanned: true` row MUST also declare its `topics` — a `LiveTopic` value or
 * an entity typename, listing EVERY target the mutation fans into.
 * `fabrika guard fanout-guard check` fails the build on a missing key, a fanned
 * mutation whose feature omits the publish, or a `topics` value the feature's
 * `live.ts` no longer targets (a mis-aimed publish, #2554).
 */

export interface FannedMutationEntry {
	/** The `entity.verb` key, exactly as it appears in `Fate.mutation("<key>", …)`. */
	readonly key: string;
	readonly fanned: boolean;
	/** Required on a `fanned: true` row; omitted otherwise. */
	readonly topics?: ReadonlyArray<string>;
	/** One line: WHY it does / does not fan. */
	readonly rationale: string;
}

/** Grouped by feature for readability only — the guard flattens it. */
export const FANNED_MUTATIONS: ReadonlyArray<FannedMutationEntry> = [
	{
		key: "post.submit",
		fanned: true,
		topics: ["posts"],
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
		topics: ["Post"],
		rationale: "updates the Post's score/myVote fields other clients subscribe to",
	},
	{
		key: "post.retractVote",
		fanned: true,
		topics: ["Post"],
		rationale: "updates the Post's score/myVote fields other clients subscribe to",
	},
	{
		key: "post.react",
		fanned: true,
		topics: ["Post"],
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
		topics: ["Post"],
		rationale: "updates the Post's body/title fields other clients subscribe to",
	},
	{
		key: "post.delete",
		fanned: true,
		topics: ["Post", "posts"],
		rationale: "drops the Post edge from the `posts` feed connection",
	},
	{
		key: "post.restore",
		fanned: true,
		topics: ["posts"],
		rationale: "re-appends the Post edge into the `posts` feed connection",
	},
	{
		key: "comment.add",
		fanned: true,
		topics: ["Post.comments"],
		rationale: "appends a new Comment edge into the post's `Post.comments` connection",
	},
	{
		key: "comment.vote",
		fanned: true,
		topics: ["Comment"],
		rationale: "updates the Comment's score/myVote fields other clients subscribe to",
	},
	{
		key: "comment.retractVote",
		fanned: true,
		topics: ["Comment"],
		rationale: "updates the Comment's score/myVote fields other clients subscribe to",
	},
	{
		key: "comment.react",
		fanned: true,
		topics: ["Comment"],
		rationale: "updates the Comment's reaction aggregate other clients subscribe to",
	},
	{
		key: "comment.edit",
		fanned: true,
		topics: ["Comment"],
		rationale: "updates the Comment's body other clients subscribe to",
	},
	{
		key: "comment.delete",
		fanned: true,
		topics: ["Comment", "Post.comments", "Post"],
		rationale:
			"tombstones/drops the Comment edge in `Post.comments` and updates the parent Post's commentCount",
	},
	{
		key: "comment.restore",
		fanned: true,
		topics: ["Post.comments", "Post"],
		rationale:
			"re-appends the Comment edge into `Post.comments` and updates the parent Post's commentCount",
	},

	{
		key: "definition.add",
		fanned: true,
		topics: ["Term.definitions"],
		rationale: "appends a new Definition edge into the term's `Term.definitions` connection",
	},
	{
		key: "definition.vote",
		fanned: true,
		topics: ["Definition"],
		rationale: "updates the Definition's score/myVote fields other clients subscribe to",
	},
	{
		key: "definition.retractVote",
		fanned: true,
		topics: ["Definition"],
		rationale: "updates the Definition's score/myVote fields other clients subscribe to",
	},
	{
		key: "definition.react",
		fanned: true,
		topics: ["Definition"],
		rationale: "updates the Definition's reaction aggregate other clients subscribe to",
	},
	{
		key: "definition.edit",
		fanned: true,
		topics: ["Definition"],
		rationale: "updates the Definition's body other clients subscribe to",
	},
	{
		key: "definition.delete",
		fanned: true,
		topics: ["Definition", "Term.definitions"],
		rationale: "drops the Definition edge from `Term.definitions`",
	},
	{
		key: "definition.restore",
		fanned: true,
		topics: ["Term.definitions"],
		rationale: "re-appends the Definition edge into `Term.definitions`",
	},

	{
		key: "report.submit",
		fanned: false,
		rationale: "writes a report row on the moderation queue — no subscribed content connection",
	},
	// report publishes THROUGH pano/sözlük's bindings (report/live.ts delegates), so its
	// target set is their union and the guard must resolve the delegation to reach them.
	{
		key: "report.resolve",
		fanned: true,
		topics: ["Post", "posts", "Comment", "Post.comments", "Definition", "Term.definitions"],
		rationale:
			"a `remove` action evicts a fanned Post/Comment/Definition from its subscribed connection",
	},
	{
		key: "report.restore",
		fanned: true,
		topics: ["Post", "posts", "Comment", "Post.comments", "Definition", "Term.definitions"],
		rationale: "re-enters a moderator-restored fanned entity into its subscribed connection",
	},
	{
		key: "report.restoreWave",
		fanned: true,
		topics: ["Post", "posts", "Comment", "Post.comments", "Definition", "Term.definitions"],
		rationale: "re-enters every fanned entity in the restored wave into its subscribed connection",
	},

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

	{
		key: "divan.vote",
		fanned: false,
		rationale:
			"scores a sandboxed çaylak item that is deliberately excluded from the public feed connection",
	},

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
	{
		key: "user.setRole",
		fanned: false,
		rationale:
			"writes the `moderates` relation tuple + an audited role event on the identity/authority surface (#3522) — no Post/Comment/Definition in a subscribed content connection (mirrors user.banUser); the derived roster role re-reads the tuple through the gated UserAdmin view",
	},
	{
		key: "emailDelivery.mark",
		fanned: false,
		rationale:
			"appends a manual `fail` event to the append-only email-delivery log (an admin audit surface, epic #2687) — no Post/Comment/Definition in a subscribed content connection",
	},
	{
		key: "emailDelivery.clear",
		fanned: false,
		rationale:
			"appends a `clear` event to the email-delivery log — no fanned content entity (mirrors emailDelivery.mark)",
	},

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

	{
		key: "mute.set",
		fanned: false,
		rationale:
			"writes the caller's private (muter,muted) mute relation; a mute masks only the muter's OWN reads (the read-mask is a sibling), so it writes no fanned content entity — and its own views are per-viewer, so a publish onto the login-blind shared topic would over-fan/leak to all viewers (the post.save precedent). No cross-viewer fan-out",
	},
	{
		key: "mute.remove",
		fanned: false,
		rationale:
			"clears the caller's private (muter,muted) mute relation; per-viewer own-read mask, same no-fan rationale as `mute.set`",
	},
];
