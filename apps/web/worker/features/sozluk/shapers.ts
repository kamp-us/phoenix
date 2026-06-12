/**
 * Sözlük wire-entity shapers — `Term` / `Definition`.
 *
 * Every `{__typename: "Term" | "Definition", …}` literal is built here, once;
 * resolvers, lists, and mutations call a shaper instead of hand-restating the
 * literal so adding or renaming a field is a one-line edit and the
 * read/list/write paths can never drift out of byte-for-byte agreement.
 *
 * Shapers take already-resolved field values, not service rows — the mapping
 * from a given source row (a `TermPage`, a `TermSummaryRow`, a vote result)
 * onto the wire fields stays at the call site, because each source carries
 * different field names; the shaper owns only the wire shape itself.
 *
 * See `.patterns/fate-connections.md`, `.patterns/fate-effect-operations.md`.
 */

import type {TermPage} from "./Sozluk.ts";
import type {Definition, Term} from "./views.ts";

export interface TermFields {
	slug: string;
	title: string;
	count: number;
	totalScore: number;
	excerpt: string | null;
	firstAt: Date | null;
	lastEdit: Date | null;
	firstLetter: string;
	definitionCount: number;
	lastActivityAt: Date | null;
}

/**
 * Shape resolved term fields into the `Term` wire entity. `id` === `slug` (the
 * client's normalization key for a term is its slug).
 */
export const toTerm = (r: TermFields): Term => ({
	__typename: "Term",
	id: r.slug,
	slug: r.slug,
	title: r.title,
	count: r.count,
	totalScore: r.totalScore,
	excerpt: r.excerpt,
	firstAt: r.firstAt,
	lastEdit: r.lastEdit,
	firstLetter: r.firstLetter,
	definitionCount: r.definitionCount,
	lastActivityAt: r.lastActivityAt,
});

/**
 * Shape a detail `TermPage` (from `Sozluk.getTerm`) onto the `Term` wire entity.
 * The detail page carries no `excerpt` and derives `firstLetter` from the
 * title/slug; `count`/`definitionCount` both come from `totalDefinitions` and
 * `lastActivityAt` mirrors `lastEdit`. The single mapping shared by the read
 * resolver (`queries.term`) and the delete-refresh (`mutations.definition.delete`)
 * so they can't drift.
 */
export const toTermFromPage = (page: TermPage): Term =>
	toTerm({
		slug: page.slug,
		title: page.title,
		count: page.totalDefinitions,
		totalScore: page.totalScore,
		excerpt: null,
		firstAt: page.firstAt,
		lastEdit: page.lastEdit,
		firstLetter: (page.title?.[0] ?? page.slug.charAt(0) ?? "").toLowerCase(),
		definitionCount: page.totalDefinitions,
		lastActivityAt: page.lastEdit,
	});

export interface DefinitionFields {
	id: string;
	body: string;
	score: number;
	author: string;
	authorId: string;
	createdAt: Date;
	updatedAt: Date;
	myVote?: number | null;
}

/** Shape resolved definition fields into the `Definition` wire entity. */
export const toDefinition = (r: DefinitionFields): Definition => ({
	__typename: "Definition",
	id: r.id,
	body: r.body,
	score: r.score,
	author: r.author,
	authorId: r.authorId,
	createdAt: r.createdAt,
	updatedAt: r.updatedAt,
	myVote: r.myVote ?? null,
});
