/**
 * Mutation resolvers — the sozluk write path.
 *
 * Per ADR 0020, mutations are `Fate.mutation` def + `Effect.fn` pairs named
 * `entity.verb` (`.patterns/fate-effect-operations.md`). Each calls a `Sozluk`
 * service method, then returns the **re-resolved affected entity** shaped
 * exactly like a read; a delete returns the re-resolved **parent** (`Term`) so
 * the client's normalized cache updates the surrounding list.
 *
 * Input Schemas carry the wire field shapes only — domain validation stays in
 * the service (ADR 0013); domain failures (`BodyRequired`, `BodyTooLong`,
 * `DefinitionNotFound`, `UnauthorizedDefinitionMutation`) are declared on each
 * definition and surface through their `fateWireCode` annotations as stable
 * wire codes (`.patterns/fate-effect-wire-errors.md`). Infra failures never
 * reach this layer — they die inside the domain service (the boundary rule in
 * `.patterns/feature-services.md`).
 *
 * `CurrentUser.required` gates every write (anonymous → `UNAUTHORIZED`). The
 * vote mutations stamp `myVote` authoritatively from the vote write so the
 * field is correct without a follow-up `user_vote` read.
 *
 * Live publishes go through `LivePublisher` — every publish method's error
 * channel is `never`, so a failed publish can never fail the mutation
 * (`.patterns/fate-effect-server.md`).
 */

import {CurrentUser, Fate, LivePublisher, Unauthorized} from "@phoenix/fate-effect";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {
	BodyRequired,
	BodyTooLong,
	DefinitionNotFound,
	UnauthorizedDefinitionMutation,
} from "./errors.ts";
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

/**
 * The service definition results name the id `definitionId` and the author
 * `authorName`; the `toDefinition` shaper takes the wire field names, so map
 * those two keys here before shaping.
 */
const shapeDefinition = (r: {
	definitionId: string;
	body: string;
	authorName: string;
	authorId: string;
	score: number;
	createdAt: Date;
	updatedAt: Date;
	myVote?: number | null;
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
			const live = yield* LivePublisher;
			const result = yield* sozluk.addDefinition({
				termSlug: input.termSlug,
				authorId: user.id,
				authorName: user.name ?? user.email,
				body: input.body,
				...(input.termTitle ? {termTitle: input.termTitle} : {}),
			});
			// Fresh write: not yet voted by anyone.
			const definition = shapeDefinition({...result, myVote: null});
			// New definition joins the term's list: append its node to the
			// `Term.definitions` connection keyed by the term slug (the same key
			// `definition.delete` removes from). This drives every open term page —
			// including the author's own — without a reload. Inline node; the DO does
			// no DB work and each client masks `data` to its own selection.
			yield* live
				.connection("Term.definitions", {id: input.termSlug})
				.appendNode("Definition", definition.id, {node: definition});
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
			const live = yield* LivePublisher;
			const result = yield* sozluk.voteDefinition({definitionId: input.id, voterId: user.id});
			const definition = shapeDefinition(result);
			// Publish the re-resolved entity inline; the DO does no DB work and each
			// client masks `data` to its own selection. `myVote` is viewer-specific,
			// so it's omitted from `changed` (clients keep their own).
			yield* live.update("Definition", definition.id, {changed: ["score"], data: definition});
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
			const live = yield* LivePublisher;
			const result = yield* sozluk.retractDefinitionVote({
				definitionId: input.id,
				voterId: user.id,
			});
			const definition = shapeDefinition(result);
			yield* live.update("Definition", definition.id, {changed: ["score"], data: definition});
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
			const live = yield* LivePublisher;
			const result = yield* sozluk.editDefinition({
				definitionId: input.id,
				actorId: user.id,
				body: input.body,
			});
			// Re-read the viewer's vote so the edited entity carries an accurate
			// `myVote` (edit doesn't change vote state, but the read shouldn't
			// drop it). Batched single-id read.
			const [fresh] = yield* sozluk.getDefinitionsByIds([result.definitionId], {viewerId: user.id});
			const definition = shapeDefinition({...result, myVote: fresh?.myVote ?? null});
			// `body` changed; `myVote` is viewer-specific so left out of `changed`.
			yield* live.update("Definition", definition.id, {changed: ["body"], data: definition});
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
			const live = yield* LivePublisher;
			// Resolve the parent slug before the delete (the row still exists),
			// so we can re-resolve the parent `Term` afterward.
			const slug = yield* sozluk.lookupDefinitionTermSlug(input.id);
			yield* sozluk.deleteDefinition({definitionId: input.id, actorId: user.id});
			// The entity is gone, and its edge leaves the parent term's connection.
			yield* live.delete("Definition", input.id);
			if (slug) {
				yield* live.connection("Term.definitions", {id: slug}).deleteEdge("Definition", input.id);
			}
			if (!slug) return null;
			const page = yield* sozluk.getTerm(slug);
			if (!page) return null;
			return toTermFromPage(page);
		}),
	),
};
