/**
 * Mutation resolvers — the sozluk write path (ADR 0020). Each mutation calls a `Sozluk`
 * service method then returns the re-resolved affected entity; a delete returns the
 * re-resolved parent `Term` so the client's normalized cache updates the surrounding list.
 *
 * A live publish has `E = never`, so it can never fail the mutation
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
import {currentSandboxViewer, decidePublish, sandboxedAtForAuthor} from "../kunye/sandbox.ts";
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

// Branded id schemas decode byte-identically (the brand is type-only) but carry the
// nominal tag downstream, so the service-call surface below gets typed ids for free.
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

// A NON-palette string fails to decode at the wire boundary, so an arbitrary emoji is
// structurally unrepresentable and never reaches the service.
const ReactDefinitionInput = Schema.Struct({
	id: DefinitionId,
	emoji: Schema.NullOr(ReactionEmojiSchema),
});

// Service results name the id `definitionId` / author `authorName`; remap to wire names.
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
				// A çaylak's new definition lands sandboxed; a yazar's is live (#1205).
				const sandboxedAt = yield* sandboxedAtForAuthor(user.id, new Date());
				const result = yield* sozluk.addDefinition({
					termSlug: input.termSlug,
					authorId: UserId.make(user.id),
					authorName: authorDisplayLabel(user),
					body: input.body,
					sandboxedAt,
					...(input.termTitle ? {termTitle: input.termTitle} : {}),
				});
				const definition = shapeDefinition({...result, myVote: null});
				// The term topic is viewer-blind, so a sandboxed node would leak to non-author and
				// anonymous subscribers — hence the `decidePublish` gate.
				yield* live.definition
					.term(input.termSlug)
					.appendNode(definition.id, {node: definition}, decidePublish(sandboxedAt));
				// A sandboxed definition that is the çaylak's FIRST pending item pages the moderators.
				yield* notifyCaylakEntersDivan({authorId: user.id, sandboxedAt});
				return definition;
			});
			// Post-value karma gate, dark behind `phoenix-karma-gates` — the same ≥ −4 floor as pano's.
			return yield* gateContentOnKarma(add());
		}),
	),
	"definition.vote": Fate.mutation(
		{
			input: DefinitionIdInput,
			type: DefinitionView,
			// `VoterNotEligible` is the "earn to vote" gate, `SelfVoteNotAllowed` the founder-ruled
			// self-vote block. Both cast-only; retraction is exempt for each.
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
			// A landed upvote notifies the author, rolled up per item, on a real state change only.
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
	// `CurrentUser.required` is the ONLY gate — deliberately NO voter-tier gate and NO karma
	// write, so a çaylak may react. Ships dark behind the default-off `phoenix-reactions`.
	"definition.react": Fate.mutation(
		{
			input: ReactDefinitionInput,
			type: DefinitionView,
			error: Schema.Union([Unauthorized, DefinitionNotFound]),
		},
		Effect.fn("definition.react")(function* ({input}) {
			const user = yield* CurrentUser.required;
			const sozluk = yield* Sozluk;
			// Dark-ship gate (ADR 0083). Off ⇒ inert: re-resolve the definition unchanged so the
			// caller's cache stays consistent. A Flagship outage reads `false` and stays dark.
			const flags = yield* Flags;
			const on = yield* flags.getBoolean(PHOENIX_REACTIONS, false).pipe(provideRequestFlags);
			if (!on) {
				const sandboxViewer = yield* currentSandboxViewer;
				const [current] = yield* sozluk.getDefinitionsByIds([input.id], {
					viewerId: user.id,
					sandboxViewer,
				});
				if (!current) {
					return yield* new DefinitionNotFound({
						definitionId: input.id,
						message: `definition ${input.id} not found`,
					});
				}
				return toDefinition(current);
			}
			// The publish fans the fresh aggregate out to every open subscriber, so a reader
			// watching the term sees the count move.
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
			// Re-read the viewer's vote so the edit doesn't blank `myVote`.
			const sandboxViewer = yield* currentSandboxViewer;
			const [fresh] = yield* sozluk.getDefinitionsByIds([result.definitionId], {
				viewerId: user.id,
				sandboxViewer,
			});
			const definition = shapeDefinition({...result, myVote: fresh?.myVote ?? null});
			yield* live.definition.update(definition.id, {changed: ["body"], data: definition});
			return definition;
		}),
	),
	"definition.delete": Fate.mutation(
		{
			// A delete returns the re-resolved **parent** `Term` (ADR 0020).
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
			const sandboxViewer = yield* currentSandboxViewer;
			const page = yield* sozluk.getTerm(slug, {viewerId: user.id, sandboxViewer});
			if (!page) return null;
			return toTermFromPage(page);
		}),
	),

	// Restore (un-delete) a removed definition (ADR 0096 §4); returns the parent `Term`.
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
			const sandboxViewer = yield* currentSandboxViewer;
			const page = yield* sozluk.getTerm(slug, {viewerId: user.id, sandboxViewer});
			if (!page) return null;
			const restored = page.definitions.find((d) => d.id === input.id);
			if (restored) {
				// Re-enter the term topic — the inverse of the delete path's `deleteEdge`.
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
				// Sandbox-faithful restore: a çaylak's definition round-trips back to sandboxed, so a
				// sandboxed restore stays suppressed from the viewer-blind term topic.
				yield* live.definition
					.term(slug)
					.appendNode(restored.id, {node}, decidePublish(restoreResult.sandboxedAt ?? null));
			}
			return toTermFromPage(page);
		}),
	),
};
