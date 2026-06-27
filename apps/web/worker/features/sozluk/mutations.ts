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
import {WorkerLivePublisher} from "../fate-live/protocol.ts";
import {sandboxedAtForAuthor} from "../kunye/sandbox.ts";
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

const AddDefinitionInput = Schema.Struct({
	termSlug: Schema.String,
	termTitle: Schema.optional(Schema.NullOr(Schema.String)),
	body: Schema.String,
});

const EditDefinitionInput = Schema.Struct({
	id: Schema.String,
	body: Schema.String,
});

const DefinitionIdInput = Schema.Struct({
	id: Schema.String,
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
			error: Schema.Union([Unauthorized, BodyRequired, BodyTooLong]),
		},
		Effect.fn("definition.add")(function* ({input}) {
			const user = yield* CurrentUser.required;
			const sozluk = yield* Sozluk;
			const live = sozlukLive(yield* WorkerLivePublisher);
			// A çaylak's new definition lands sandboxed when the authorship-loop flag
			// is on; flag-off / yazar ⇒ live, exactly as today (#1205).
			const sandboxedAt = yield* sandboxedAtForAuthor(user.id, new Date());
			const result = yield* sozluk.addDefinition({
				termSlug: input.termSlug,
				authorId: user.id,
				authorName: user.name ?? user.email,
				body: input.body,
				sandboxedAt,
				...(input.termTitle ? {termTitle: input.termTitle} : {}),
			});
			// Fresh write: not yet voted by anyone.
			const definition = shapeDefinition({...result, myVote: null});
			// Append the node to the term's `Term.definitions` topic (same key
			// `definition.delete` removes from) so every open term page updates live.
			yield* live.definition.term(input.termSlug).appendNode(definition.id, {node: definition});
			return definition;
		}),
	),
	"definition.vote": Fate.mutation(
		{
			input: DefinitionIdInput,
			type: DefinitionView,
			error: Schema.Union([Unauthorized, DefinitionNotFound]),
		},
		Effect.fn("definition.vote")(function* ({input}) {
			const user = yield* CurrentUser.required;
			const sozluk = yield* Sozluk;
			const live = sozlukLive(yield* WorkerLivePublisher);
			const result = yield* sozluk.voteDefinition({definitionId: input.id, voterId: user.id});
			const definition = shapeDefinition(result);
			// `myVote` is viewer-specific, so it's omitted from `changed`.
			yield* live.definition.update(definition.id, {changed: ["score"], data: definition});
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
				voterId: user.id,
			});
			const definition = shapeDefinition(result);
			yield* live.definition.update(definition.id, {changed: ["score"], data: definition});
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
				actorId: user.id,
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
			yield* sozluk.deleteDefinition({definitionId: input.id, actorId: user.id});
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
			yield* sozluk.restoreDefinition({definitionId: input.id, actorId: user.id});
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
				yield* live.definition.term(slug).appendNode(restored.id, {node});
			}
			return toTermFromPage(page);
		}),
	),
};
