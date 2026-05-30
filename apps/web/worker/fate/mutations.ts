/**
 * Mutation resolvers — the sozluk write path.
 *
 * Per ADR 0020, mutations are `{type, input?, resolve: fateMutation(...)}`,
 * named `entity.verb`. Each calls a `Sozluk` service method, then returns the
 * **re-resolved affected entity** shaped exactly like a read; a delete returns
 * the re-resolved **parent** (`Term`) so the client's normalized cache updates
 * the surrounding list.
 *
 * Validation stays in the service (ADR 0013) — the resolvers carry no `input`
 * schema beyond the thin coercion fate does at the boundary; domain failures
 * (`BodyRequired`, `BodyTooLong`, `DefinitionNotFound`,
 * `UnauthorizedDefinitionMutation`) surface through the bridge's
 * `encodeFateError` as stable wire codes.
 *
 * `Auth.required` gates every write (anonymous → `UNAUTHORIZED`). The vote
 * mutations stamp `myVote` authoritatively from the vote write so the field is
 * correct without a follow-up `user_vote` read.
 *
 * See `.patterns/fate-mutations.md`, `.patterns/fate-effect-bridge.md`.
 */

import {liveBus} from "../features/fate-live/event-bus.ts";
import {Auth} from "../features/pasaport/Auth.ts";
import {Sozluk} from "../features/sozluk/Sozluk.ts";
import {fateMutation} from "./effect.ts";
import {toDefinition, toTermFromPage} from "./shapers.ts";
import type {Definition, Term} from "./views.ts";

export interface AddDefinitionInput {
	termSlug: string;
	termTitle?: string | null;
	body: string;
}
export interface EditDefinitionInput {
	id: string;
	body: string;
}
export interface DefinitionIdInput {
	id: string;
}

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
	"definition.add": {
		type: "Definition",
		resolve: fateMutation<AddDefinitionInput, Definition>(function* ({input}) {
			const {user} = yield* Auth.required;
			const sozluk = yield* Sozluk;
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
			liveBus
				.connection("Term.definitions", {id: input.termSlug})
				.appendNode("Definition", definition.id, {node: definition});
			return definition;
		}),
	},
	"definition.vote": {
		type: "Definition",
		resolve: fateMutation<DefinitionIdInput, Definition>(function* ({input}) {
			const {user} = yield* Auth.required;
			const sozluk = yield* Sozluk;
			const result = yield* sozluk.voteDefinition({
				definitionId: input.id,
				voterId: user.id,
			});
			const definition = shapeDefinition(result);
			// Publish the re-resolved entity inline; the DO does no DB work and each
			// client masks `data` to its own selection. `myVote` is viewer-specific,
			// so it's omitted from `changed` (clients keep their own).
			liveBus.update("Definition", definition.id, {changed: ["score"], data: definition});
			return definition;
		}),
	},
	"definition.retractVote": {
		type: "Definition",
		resolve: fateMutation<DefinitionIdInput, Definition>(function* ({input}) {
			const {user} = yield* Auth.required;
			const sozluk = yield* Sozluk;
			const result = yield* sozluk.retractDefinitionVote({
				definitionId: input.id,
				voterId: user.id,
			});
			const definition = shapeDefinition(result);
			liveBus.update("Definition", definition.id, {changed: ["score"], data: definition});
			return definition;
		}),
	},
	"definition.edit": {
		type: "Definition",
		resolve: fateMutation<EditDefinitionInput, Definition>(function* ({input}) {
			const {user} = yield* Auth.required;
			const sozluk = yield* Sozluk;
			const result = yield* sozluk.editDefinition({
				definitionId: input.id,
				actorId: user.id,
				body: input.body,
			});
			// Re-read the viewer's vote so the edited entity carries an accurate
			// `myVote` (edit doesn't change vote state, but the read shouldn't
			// drop it). Batched single-id read.
			const [fresh] = yield* sozluk.getDefinitionsByIds([result.definitionId], {
				viewerId: user.id,
			});
			const definition = shapeDefinition({...result, myVote: fresh?.myVote ?? null});
			// `body` changed; `myVote` is viewer-specific so left out of `changed`.
			liveBus.update("Definition", definition.id, {changed: ["body"], data: definition});
			return definition;
		}),
	},
	"definition.delete": {
		// A delete returns the re-resolved **parent** `Term` so the client's
		// normalized cache updates the surrounding definitions list (ADR 0020).
		type: "Term",
		resolve: fateMutation<DefinitionIdInput, Term | null>(function* ({input}) {
			const {user} = yield* Auth.required;
			const sozluk = yield* Sozluk;
			// Resolve the parent slug before the delete (the row still exists),
			// so we can re-resolve the parent `Term` afterward.
			const slug = yield* sozluk.lookupDefinitionTermSlug(input.id);
			yield* sozluk.deleteDefinition({definitionId: input.id, actorId: user.id});
			// The entity is gone, and its edge leaves the parent term's connection.
			liveBus.delete("Definition", input.id);
			if (slug) {
				liveBus.connection("Term.definitions", {id: slug}).deleteEdge("Definition", input.id);
			}
			if (!slug) return null;
			const page = yield* sozluk.getTerm(slug);
			if (!page) return null;
			return toTermFromPage(page);
		}),
	},
};
