/**
 * Sözlük fate data views — `Term`, `Definition`.
 *
 * Data views are the schema (ADR 0018): each view is a `FateDataView` class
 * whose static `view` IS the kernel `dataView()` output and whose `Entity<>`
 * derivation is the client's type (codegen, no schema artifact). IDs are raw
 * per-type values — no global-ID encoding, no `Node` interface.
 *
 * `Term.definitions` is a `FateDataView.list(DefinitionView, {orderBy})` whose
 * `orderBy` is kept in lockstep with the service's term-page `ORDER BY`
 * (`score desc, createdAt asc, id asc`) so the keyset cursors round-trip
 * (ADR 0019; see `.patterns/fate-connections.md`).
 *
 * See `.patterns/fate-effect-data-views.md`.
 */
import {type Entity, FateDataView} from "@phoenix/fate-effect";
import type {ViewRow} from "../fate/view-types.ts";
import type {DefinitionRow, TermSummaryRow} from "./Sozluk.ts";

/**
 * The view row types — mapped restatements of the service rows
 * (`Record<string, unknown>`-assignable, which the plain row interfaces are
 * not). Exported because the `Fate.source` entries over these views surface
 * the row type in their declarations (`fate/sources.ts` — TS2883 portability).
 */
export type DefinitionViewRow = ViewRow<DefinitionRow>;
export type TermViewRow = ViewRow<TermSummaryRow>;

/**
 * `Definition` — a single dictionary entry.
 *
 * `author` is the plain author-name string (not a nested `User`), `authorId`
 * gates the edit/delete affordances, and `myVote` is the viewer's `1 | null`
 * upvote flag. The read path batches `myVote` for a whole definition list in one
 * `user_vote` query (`Sozluk.getDefinitionsByIds` / `listDefinitionsKeyset`), so
 * it surfaces here as a plain stamped scalar (no per-row resolver, no N+1).
 */
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

/**
 * The kernel views, for the cross-feature surfaces that want fate's plain
 * `dataView()` value (the `fate/views.ts` `Root` map + barrel re-exports).
 */
export const definitionDataView = DefinitionView.view;
export const termDataView = TermView.view;

/*
 * The `Replacements` second parameter restates two things fate's wire-facing
 * `Entity<>` derivation widens/narrows away:
 *
 *   - list relations (`definitions`) — kernel `list()` widens the child field
 *     map, the same reason fate's own docs use `Replacements`;
 *   - timestamp fields — fate types `Date` row fields as `string` (the
 *     JSON-serialized wire shape), but these worker-side entity values carry
 *     live `Date` objects until fate serializes the response. The shapers and
 *     every worker call site operate pre-serialization, so the types restate
 *     the bridge-era row truth (the SPA's date helpers accept both).
 */
export type Definition = Entity<typeof DefinitionView, {createdAt: Date; updatedAt: Date}>;
export type Term = Entity<
	typeof TermView,
	{
		firstAt: Date | null;
		lastEdit: Date | null;
		lastActivityAt: Date | null;
		definitions?: Definition[];
	}
>;
