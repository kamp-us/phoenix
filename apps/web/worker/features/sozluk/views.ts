/**
 * Sözlük fate data views — `Term`, `Definition` (ADR 0018; see
 * `.patterns/fate-effect-data-views.md`).
 *
 * `Term.definitions`' `orderBy` MUST stay in lockstep with the service's
 * term-page `ORDER BY` (`score desc, createdAt asc, id asc`) or the keyset
 * cursors stop round-tripping (ADR 0019; see `.patterns/fate-connections.md`).
 */
import {FateDataView, type WorkerEntity} from "@kampus/fate-effect";
import type {ViewRow} from "../fate/view-types.ts";
import type {DefinitionRow, TermSummaryRow} from "./Sozluk.ts";

// Mapped restatements of the service rows so they're `Record<string, unknown>`-
// assignable (the plain row interfaces are not). Exported because the
// `Fate.source` entries surface the row type in their declarations (TS2883).
export type DefinitionViewRow = ViewRow<DefinitionRow>;
export type TermViewRow = ViewRow<TermSummaryRow>;

export class DefinitionView extends FateDataView<DefinitionViewRow>()("Definition")({
	id: true,
	body: true,
	score: true,
	author: true,
	authorId: true,
	createdAt: true,
	updatedAt: true,
	myVote: true,
}) {}

/**
 * `Term` — a dictionary headword. The view is over `TermSummaryRow`; the
 * detail-page `term(slug)` resolver reshapes its `TermPage` into the same shape.
 * `definitions.orderBy` must equal the service term-page `ORDER BY` (ADR 0019).
 */
export class TermView extends FateDataView<TermViewRow>()("Term")({
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
	definitions: FateDataView.list(DefinitionView, {
		orderBy: [{score: "desc"}, {createdAt: "asc"}, {id: "asc"}],
	}),
}) {}

export const definitionDataView = DefinitionView.view;
export const termDataView = TermView.view;

export type Definition = WorkerEntity<typeof DefinitionView, "createdAt" | "updatedAt">;
export type Term = WorkerEntity<
	typeof TermView,
	"firstAt" | "lastEdit" | "lastActivityAt",
	{definitions?: Definition[]}
>;
