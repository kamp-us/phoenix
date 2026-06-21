/**
 * Sözlük wire-entity shapers — `Term` / `Definition`. Every
 * `{__typename, …}` literal is built here once so the read/list/write paths
 * can't drift out of agreement. Shapers take already-resolved field values, not
 * service rows: each source (`TermPage`, `TermSummaryRow`, a vote result) names
 * its fields differently, so the row→wire mapping stays at the call site and the
 * shaper owns only the wire shape.
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

// `id` === `slug` (the client's normalization key for a term is its slug).
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
 * Map a detail `TermPage` onto the `Term` wire entity — shared by the read
 * resolver (`queries.term`) and the delete-refresh so they can't drift. The
 * detail page has no `excerpt`, derives `firstLetter` from title/slug, and uses
 * `totalDefinitions` for both counts; `lastActivityAt` mirrors `lastEdit`.
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
	myVote?: boolean | null;
}

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
