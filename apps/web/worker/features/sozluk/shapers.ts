/**
 * Sözlük wire-entity shapers — `Term` / `Definition`. Every `{__typename, …}` literal is
 * built here once so the read/list/write paths can't drift out of agreement. Both entities
 * take their wire-named field set from a single column→field map (`definition-fields.ts` /
 * `term-fields.ts`), so a one-field change touches that map, not a parallel restatement.
 */

import {EMPTY_REACTION_AGGREGATE} from "../reaction/Reaction.ts";
import type {DefinitionRow} from "./definition-fields.ts";
import type {TermPage} from "./Sozluk.ts";
import type {TermSummaryRow} from "./term-fields.ts";
import type {Definition, Term} from "./views.ts";

export type {DefinitionRow};

// Input is the map-derived `TermSummaryRow`, not a parallel interface, so the wire shaper's
// field set can't drift from `toTermSummaryRow` or `termViewFields`. `id` === `slug`.
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

// Shared by the read resolver and the delete-refresh so they can't drift. The detail page has
// no `excerpt`, derives `firstLetter` from title/slug, and uses `totalDefinitions` for both
// counts; `lastActivityAt` mirrors `lastEdit`.
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

// Input is the map-derived `DefinitionRow`, not a parallel interface, so the wire shaper's
// field set can't drift from `toDefinitionRow` or `definitionViewFields`.
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
	sandboxed: r.sandboxed ?? false,
	reactions: r.reactions ?? EMPTY_REACTION_AGGREGATE,
});
