/**
 * Sözlük wire-entity shapers — `Term` / `Definition`. Every
 * `{__typename, …}` literal is built here once so the read/list/write paths
 * can't drift out of agreement.
 *
 * Both entities take their wire-named field set from a single column→field map —
 * `Definition` from `definition-fields.ts` (#1126), `Term` from `term-fields.ts`
 * (#1544) — so the row mapper (`toDefinitionRow` / `toTermSummaryRow`), the wire
 * shaper's input type (`DefinitionRow` / `TermSummaryRow`), and the view field
 * list all derive from one declaration: a one-field change touches that map, not a
 * parallel restatement. Each `toX` here takes the map-derived row and stamps
 * `__typename` (+ `Definition`'s `myVote` viewer-scalar default) onto the
 * already-wire-named fields. `toTermFromPage` adapts the detail `TermPage` source
 * onto the same row shape at the call site.
 */

import {EMPTY_REACTION_AGGREGATE} from "../reaction/Reaction.ts";
import type {DefinitionRow} from "./definition-fields.ts";
import type {TermPage} from "./Sozluk.ts";
import type {TermSummaryRow} from "./term-fields.ts";
import type {Definition, Term} from "./views.ts";

export type {DefinitionRow};

// `toTerm`'s input is the map-derived `TermSummaryRow` (the intrinsic wire-named
// fields) — not a parallel interface — so the wire shaper's field set can't drift
// from the row mapper (`toTermSummaryRow`) or `termViewFields`. `id` === `slug`
// (the client's normalization key for a term is its slug).
export const toTerm = (r: TermSummaryRow): Term => ({
	__typename: "Term",
	id: r.id,
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
		id: page.slug,
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
	authorUsername: r.authorUsername ?? null,
	authorDisplayName: r.authorDisplayName ?? null,
	createdAt: r.createdAt,
	updatedAt: r.updatedAt,
	myVote: r.myVote ?? null,
	reactions: r.reactions ?? EMPTY_REACTION_AGGREGATE,
});
