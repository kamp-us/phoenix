/**
 * Mutation resolvers — the sozluk write path (ADR 0020). Each mutation calls a
 * `Sozluk` service method then returns the re-resolved affected entity shaped
 * like a read; a delete returns the re-resolved parent (`Term`) so the client's
 * normalized cache updates the surrounding list. Domain validation stays in the
 * service (ADR 0013); `CurrentUser.required` gates every write.
 *
 * Live publishes go through `WorkerLivePublisher`, whose publish methods have
 * `E = never`, so a failed publish can never fail the mutation
 * (`.patterns/fate-effect-server.md`).
 */

import {CurrentUser, Fate, Unauthorized} from "@kampus/fate-effect";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {PHOENIX_REACTIONS} from "../../../src/flags/keys.ts";
import {ReactionEmojiSchema} from "../../db/reaction-emoji.ts";
import {DefinitionId, TermSlug, UserId} from "../../lib/ids.ts";
import {notifyCaylakEntersDivan} from "../bildirim/mod-emitters.ts";
import {notifyContentVote} from "../bildirim/vote-emitters.ts";
import {WorkerLivePublisher} from "../fate-live/protocol.ts";
import {Flags} from "../flagship/Flags.ts";
import {provideRequestFlags} from "../flagship/FlagsContext.ts";
import {InsufficientKarma} from "../kunye/errors.ts";
import {gateContentOnKarma} from "../kunye/privilege.ts";
import {decidePublish, sandboxedAtForAuthor} from "../kunye/sandbox.ts";
import {authorDisplayLabel} from "../pasaport/author-label.ts";
import {SelfVoteNotAllowed, VoterNotEligible} from "../vote/errors.ts";
import {
	BodyRequired,
	BodyTooLong,
	DefinitionNotFound,
	UnauthorizedDefinitionMutation,
} from "./errors.ts";
import {sozlukLive} from "./live.ts";
import {Sozluk} from "./Sozluk.ts";
import {toDefinition, toTermFromPage} from "./shapers.ts";
import type {Definition} from "./views.ts";
import {DefinitionView, TermView} from "./views.ts";

// Branded id schemas decode byte-identically (the brand is type-only) but carry
// the nominal tag downstream, so `input.id` / `input.termSlug` arrive already
// typed as DefinitionId / TermSlug for the service-call surface below.
const AddDefinitionInput = Schema.Struct({
	termSlug: TermSlug,
	termTitle: Schema.optional(Schema.NullOr(Schema.String)),
	body: Schema.String,
});

const EditDefinitionInput = Schema.Struct({
	id: DefinitionId,
	body: Schema.String,
});

const DefinitionIdInput = Schema.Struct({
	id: DefinitionId,
});

// The reaction intent decodes against the curated `REACTION_EMOJI` palette at the
// wire boundary: a palette member sets/changes the reactor's single reaction, `null`
// retracts it, and a NON-palette string fails to decode — so an arbitrary emoji is
// structurally unrepresentable, never reaching the service (#1865 AC#1).
const ReactDefinitionInput = Schema.Struct({
	id: DefinitionId,
	emoji: Schema.NullOr(ReactionEmojiSchema),
});

// Service results name the id `definitionId` / author `authorName`; the
// `toDefinition` shaper takes wire field names, so remap those two keys first.
const shapeDefinition = (r: {
	definitionId: string;
	body: string;
	authorName: string;
	authorId: string;
	score: number;
	createdAt: Date;
	updatedAt: Date;
	myVote?: boolean | null;
}): Definition =>
	toDefinition({
		id: r.definitionId,
		body: r.body,
		score: r.score,
		author: r.authorName,
		authorId: r.authorId,
		createdAt: r.createdAt,
		updatedAt: r.updatedAt,
		myVote: r.myVote ?? null,
	});

export const mutations = {
	"definition.add": Fate.mutation(
		{
			input: AddDefinitionInput,
			type: DefinitionView,
			error: Schema.Union([Unauthorized, InsufficientKarma, BodyRequired, BodyTooLong]),
		},
		Effect.fn("definition.add")(function* ({input}) {
			const user = yield* CurrentUser.required;
			const add = Effect.fn("definition.addBody")(function* () {
				const sozluk = yield* Sozluk;
				const live = sozlukLive(yield* WorkerLivePublisher);
				// A çaylak's new definition lands sandboxed when the authorship-loop flag
				// is on; flag-off / yazar ⇒ live, exactly as today (#1205).
				const sandboxedAt = yield* sandboxedAtForAuthor(user.id, new Date());
				const result = yield* sozluk.addDefinition({
					termSlug: input.termSlug,
					authorId: UserId.make(user.id),
					authorName: authorDisplayLabel(user),
					body: input.body,
					sandboxedAt,
					...(input.termTitle ? {termTitle: input.termTitle} : {}),
				});
				// Fresh write: not yet voted by anyone.
				const definition = shapeDefinition({...result, myVote: null});
				// Append the node to the term's `Term.definitions` topic (same key
				// `definition.delete` removes from) so every open term page updates live —
				// but only when the definition is live: the topic is viewer-blind, so a
				// sandboxed node would leak to non-author/anonymous subscribers (#1205 AC#2).
				yield* live.definition
					.term(input.termSlug)
					.appendNode(definition.id, {node: definition}, decidePublish(sandboxedAt));
				// Mod-queue heartbeat (#1699): a sandboxed definition that is the çaylak's
				// FIRST pending item pages the moderators — same transition gate as pano.
				yield* notifyCaylakEntersDivan({authorId: user.id, sandboxedAt});
				return definition;
			});
			// Post-value karma gate (#150), dark behind `phoenix-karma-gates` — the same
			// ≥ −4 floor as pano's `post.submit` / `comment.add`, applied to the sözlük
			// definition write path.
			return yield* gateContentOnKarma(add());
		}),
	),
	"definition.vote": Fate.mutation(
		{
			input: DefinitionIdInput,
			type: DefinitionView,
			// `VoterNotEligible` (wire `VOTE_REQUIRES_YAZAR`) — the "earn to vote" gate (#1810): a çaylak
			// newcomer is rejected at cast. `SelfVoteNotAllowed` (wire `SELF_VOTE_NOT_ALLOWED`) — the
			// founder-ruled self-vote block (#2216). Both cast-only; retraction is exempt for each.
			error: Schema.Union([Unauthorized, DefinitionNotFound, VoterNotEligible, SelfVoteNotAllowed]),
		},
		Effect.fn("definition.vote")(function* ({input}) {
			const user = yield* CurrentUser.required;
			const sozluk = yield* Sozluk;
			const live = sozlukLive(yield* WorkerLivePublisher);
			const result = yield* sozluk.voteDefinition({
				definitionId: input.id,
				voterId: UserId.make(user.id),
			});
			const definition = shapeDefinition(result);
			// `myVote` is viewer-specific, so it's omitted from `changed`.
			yield* live.definition.update(definition.id, {changed: ["score"], data: definition});
			// Aggregated vote notification (#1698): see pano's `post.vote` — a landed
			// upvote notifies the definition author, rolled up per item, on a real
			// state change only. `result.authorId` is server-derived.
			if (result.changed) {
				yield* notifyContentVote({
					authorId: result.authorId,
					voterId: user.id,
					targetKind: "definition",
					targetId: result.definitionId,
				});
			}
			return definition;
		}),
	),
	"definition.retractVote": Fate.mutation(
		{
			input: DefinitionIdInput,
			type: DefinitionView,
			error: Schema.Union([Unauthorized, DefinitionNotFound]),
		},
		Effect.fn("definition.retractVote")(function* ({input}) {
			const user = yield* CurrentUser.required;
			const sozluk = yield* Sozluk;
			const live = sozlukLive(yield* WorkerLivePublisher);
			const result = yield* sozluk.retractDefinitionVote({
				definitionId: input.id,
				voterId: UserId.make(user.id),
			});
			const definition = shapeDefinition(result);
			yield* live.definition.update(definition.id, {changed: ["score"], data: definition});
			return definition;
		}),
	),
	// Set / change / retract the viewer's single reaction on a definition (epic #1840,
	// #1865) — the cross-product twin of `definition.vote`, delegating to the ungated,
	// karma-free `Reaction` engine via `Sozluk.reactToDefinition`. `CurrentUser.required`
	// is the ONLY gate (a signed-out reactor is `Unauthorized`, same as vote's signed-out
	// gate) — deliberately NO voter-tier gate and NO karma write, so a çaylak may react
	// (#1861). Ships dark behind the default-off `phoenix-reactions` flag.
	"definition.react": Fate.mutation(
		{
			input: ReactDefinitionInput,
			type: DefinitionView,
			error: Schema.Union([Unauthorized, DefinitionNotFound]),
		},
		Effect.fn("definition.react")(function* ({input}) {
			const user = yield* CurrentUser.required;
			const sozluk = yield* Sozluk;
			// Dark-ship gate (ADR 0083): default-off `phoenix-reactions`. Off ⇒ inert — the
			// react never lands (the write is the new path, unreachable until release);
			// re-resolve the definition unchanged so the caller's cache stays consistent,
			// the divan.vote dark-ship inert-receipt shape. On a Flagship outage the safe
			// read default (`false`) keeps the path dark.
			const flags = yield* Flags;
			const on = yield* flags.getBoolean(PHOENIX_REACTIONS, false).pipe(provideRequestFlags);
			if (!on) {
				const [current] = yield* sozluk.getDefinitionsByIds([input.id], {viewerId: user.id});
				if (!current) {
					return yield* new DefinitionNotFound({
						definitionId: input.id,
						message: `definition ${input.id} not found`,
					});
				}
				return toDefinition(current);
			}
			// The mutation return re-resolves the fresh aggregate for the reactor, and
			// `live.definition.update({changed: ["reactions"]})` fans that aggregate out to
			// every open subscriber so a reader watching the term sees the count move (#1868)
			// — the reaction twin of `definition.vote`'s score publish, through the same
			// never-failing `WorkerLivePublisher`.
			const live = sozlukLive(yield* WorkerLivePublisher);
			const row = yield* sozluk.reactToDefinition({
				definitionId: input.id,
				reactorId: UserId.make(user.id),
				emoji: input.emoji,
			});
			const definition = toDefinition(row);
			yield* live.definition.update(definition.id, {changed: ["reactions"], data: definition});
			return definition;
		}),
	),
	"definition.edit": Fate.mutation(
		{
			input: EditDefinitionInput,
			type: DefinitionView,
			error: Schema.Union([
				Unauthorized,
				BodyRequired,
				BodyTooLong,
				DefinitionNotFound,
				UnauthorizedDefinitionMutation,
			]),
		},
		Effect.fn("definition.edit")(function* ({input}) {
			const user = yield* CurrentUser.required;
			const sozluk = yield* Sozluk;
			const live = sozlukLive(yield* WorkerLivePublisher);
			const result = yield* sozluk.editDefinition({
				definitionId: input.id,
				actorId: UserId.make(user.id),
				body: input.body,
			});
			// Re-read the viewer's vote so the edit doesn't drop `myVote` (edit
			// leaves vote state untouched but must not blank it).
			const [fresh] = yield* sozluk.getDefinitionsByIds([result.definitionId], {viewerId: user.id});
			const definition = shapeDefinition({...result, myVote: fresh?.myVote ?? null});
			yield* live.definition.update(definition.id, {changed: ["body"], data: definition});
			return definition;
		}),
	),
	"definition.delete": Fate.mutation(
		{
			// A delete returns the re-resolved **parent** `Term` so the client's
			// normalized cache updates the surrounding definitions list (ADR 0020).
			input: DefinitionIdInput,
			type: TermView,
			error: Schema.Union([Unauthorized, DefinitionNotFound, UnauthorizedDefinitionMutation]),
		},
		Effect.fn("definition.delete")(function* ({input}) {
			const user = yield* CurrentUser.required;
			const sozluk = yield* Sozluk;
			const live = sozlukLive(yield* WorkerLivePublisher);
			// Resolve the parent slug before the delete, while the row still exists.
			const slug = yield* sozluk.lookupDefinitionTermSlug(input.id);
			yield* sozluk.deleteDefinition({definitionId: input.id, actorId: UserId.make(user.id)});
			yield* live.definition.delete(input.id);
			if (slug) {
				yield* live.definition.term(slug).deleteEdge(input.id);
			}
			if (!slug) return null;
			const page = yield* sozluk.getTerm(slug);
			if (!page) return null;
			return toTermFromPage(page);
		}),
	),

	// Restore (un-delete) a previously removed definition (ADR 0096 §4). Returns
	// the re-resolved parent `Term`; the definition re-enters the term's list.
	"definition.restore": Fate.mutation(
		{
			input: DefinitionIdInput,
			type: TermView,
			error: Schema.Union([Unauthorized, DefinitionNotFound, UnauthorizedDefinitionMutation]),
		},
		Effect.fn("definition.restore")(function* ({input}) {
			const user = yield* CurrentUser.required;
			const sozluk = yield* Sozluk;
			const live = sozlukLive(yield* WorkerLivePublisher);
			const restoreResult = yield* sozluk.restoreDefinition({
				definitionId: input.id,
				actorId: UserId.make(user.id),
			});
			const slug = yield* sozluk.lookupDefinitionTermSlug(input.id);
			if (!slug) return null;
			const page = yield* sozluk.getTerm(slug);
			if (!page) return null;
			const restored = page.definitions.find((d) => d.id === input.id);
			if (restored) {
				// Re-enter the term's `Term.definitions` topic — the inverse of
				// the `deleteEdge` the delete path published.
				const node = toDefinition({
					id: restored.id,
					body: restored.body,
					score: restored.score,
					author: restored.author,
					authorId: restored.authorId,
					createdAt: restored.createdAt,
					updatedAt: restored.updatedAt,
					myVote: restored.myVote ?? null,
				});
				// Sandbox-faithful restore (#1811): a çaylak's sandboxed definition
				// round-trips back to Sandboxed, so route the broadcast through the
				// #1205/#1280 gate — a sandboxed restore is suppressed from the
				// viewer-blind term topic; a Live restore broadcasts as before.
				yield* live.definition
					.term(slug)
					.appendNode(restored.id, {node}, decidePublish(restoreResult.sandboxedAt ?? null));
			}
			return toTermFromPage(page);
		}),
	),
};
