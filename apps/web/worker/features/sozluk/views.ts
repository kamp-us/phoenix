/**
 * Sözlük fate data views — `Term`, `Definition`.
 *
 * Data views are the schema (ADR 0018): each `dataView` declares an entity
 * type's fields; the exported `Entity<>` types are the client's types (codegen,
 * no schema artifact). IDs are raw per-type values — no global-ID encoding, no
 * `Node` interface.
 *
 * `Term.definitions` is a `list(definitionDataView, {orderBy})` whose `orderBy`
 * is kept in lockstep with the service's term-page `ORDER BY` (`score desc,
 * createdAt asc, id asc`) so the keyset cursors round-trip (ADR 0019; see
 * `.patterns/fate-connections.md`).
 *
 * See `.patterns/fate-data-views.md`.
 */
import {dataView, list} from "@nkzw/fate/server";
import type {DataViewOf, EntityOf, ViewRow} from "../fate/view-types.ts";
import type {DefinitionRow, TermSummaryRow} from "./Sozluk.ts";

type DefinitionViewRow = ViewRow<DefinitionRow>;
type TermViewRow = ViewRow<TermSummaryRow>;

/**
 * `Definition` — a single dictionary entry.
 *
 * `author` is the plain author-name string (not a nested `User`), `authorId`
 * gates the edit/delete affordances, and `myVote` is the viewer's `1 | null`
 * upvote flag. The read path batches `myVote` for a whole definition list in one
 * `user_vote` query (`Sozluk.getDefinitionsByIds` / `listDefinitionsKeyset`), so
 * it surfaces here as a plain stamped scalar (no per-row resolver, no N+1).
 */
const definitionFields = {
	id: true,
	body: true,
	score: true,
	author: true,
	authorId: true,
	createdAt: true,
	updatedAt: true,
	myVote: true,
} as const;

export const definitionDataView: DataViewOf<DefinitionViewRow> =
	dataView<DefinitionViewRow>("Definition")(definitionFields);

/**
 * `Term` — a dictionary headword plus its connection of definitions.
 *
 * This view is over `TermSummaryRow` (the list/keyset row). The detail-page
 * `term(slug)` resolver reshapes its `TermPage` into the same row shape (see
 * `queries.ts`).
 *
 * `definitions` is the nested connection. Its `orderBy` MUST equal the service
 * term-page `ORDER BY` — `(score desc, created_at asc, id asc)` — so the
 * keyset cursors the service builds round-trip without skips or dupes
 * (ADR 0019). `id` is the explicit final tiebreaker.
 */
const termFields = {
	id: true,
	slug: true,
	title: true,
	count: true,
	totalScore: true,
	excerpt: true,
	firstAt: true,
	lastEdit: true,
	firstLetter: true,
	definitionCount: true,
	lastActivityAt: true,
} as const;

export const termDataView: DataViewOf<TermViewRow> = dataView<TermViewRow>("Term")({
	...termFields,
	definitions: list(definitionDataView, {
		orderBy: [{score: "desc"}, {createdAt: "asc"}, {id: "asc"}],
	}),
});

export type Definition = EntityOf<DefinitionViewRow, typeof definitionFields, "Definition">;
export type Term = EntityOf<TermViewRow, typeof termFields, "Term"> & {
	definitions?: Definition[];
};
