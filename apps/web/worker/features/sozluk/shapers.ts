/**
 * Sözlük wire-entity shapers — `Term` / `Definition`. Every
 * `{__typename, …}` literal is built here once so the read/list/write paths
 * can't drift out of agreement. Shapers take already-resolved field values, not
 * service rows: each source (`TermPage`, `TermSummaryRow`, a vote result) names
 * its fields differently, so the row→wire mapping stays at the call site and the
 * shaper owns only the wire shape.
 *
 * `Definition` is the one exception — its row mapper (`toDefinitionRow`), this
 * wire shaper's input type (`DefinitionRow`), and the `DefinitionView` field list
 * all derive from the single column→field map in `definition-fields.ts` (#1126
 * AC#1, deferred from #1159; the sözlük mirror of pano's #1161 collapse in PR
 * #1265), so a one-field change touches that map, not a parallel restatement.
 * `toDefinition` here takes the map-derived `DefinitionRow` and just stamps
 * `__typename` + the `myVote` viewer-scalar default onto its already-wire-named
 * fields.
 */

import type {DefinitionRow} from "./definition-fields.ts";
import type {TermPage} from "./Sozluk.ts";
import type {Definition, Term} from "./views.ts";

export type {DefinitionRow};

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

// `toDefinition`'s input is the map-derived `DefinitionRow` (the intrinsic
// wire-named fields + the optional `myVote` viewer scalar) — not a parallel
// interface — so the wire shaper's field set can't drift from the row mapper
// (`toDefinitionRow`) or `definitionViewFields`. This stamps `__typename` + the
// `myVote` viewer-scalar default onto the map's already-wire-named values.
export const toDefinition = (r: DefinitionRow): Definition => ({
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
