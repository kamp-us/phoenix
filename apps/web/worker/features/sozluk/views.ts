/**
 * Sözlük fate data views — `Term`, `Definition` (ADR 0018; see
 * `.patterns/fate-effect-data-views.md`).
 *
 * `Term.definitions`' `orderBy` and the service's term-page keyset both derive
 * from `DEFINITION_ORDERING` (`ordering.ts`), so they can't drift (ADR 0019; see
 * `.patterns/fate-connections.md`).
 */
import {FateDataView, type WorkerEntity} from "@kampus/fate-effect";
import {viewOrderBy} from "../../db/ordering.ts";
import type {ViewRow} from "../fate/view-types.ts";
import {definitionViewFields} from "./definition-fields.ts";
import {DEFINITION_ORDERING} from "./ordering.ts";
import type {DefinitionRow} from "./Sozluk.ts";
import {type TermSummaryRow, termViewFields} from "./term-fields.ts";

// Mapped restatements of the service rows so they're `Record<string, unknown>`-
// assignable (the plain row interfaces are not). Exported because the
// `Fate.source` entries surface the row type in their declarations (TS2883).
export type DefinitionViewRow = ViewRow<DefinitionRow>;
export type TermViewRow = ViewRow<TermSummaryRow>;

// The field list derives from `definition-fields.ts`'s column→field map, so it
// can't drift from the row mapper / wire shaper (#1126 AC#1).
export class DefinitionView extends FateDataView<DefinitionViewRow>()("Definition")(
	definitionViewFields,
) {}

/**
 * `Term` — a dictionary headword. The scalar fields derive from
 * `term-fields.ts`'s column→field map, so they can't drift from the row mapper /
 * wire shaper (#1544). The view is over `TermSummaryRow`; the detail-page
 * `term(slug)` resolver reshapes its `TermPage` into the same shape.
 * `definitions.orderBy` derives from `DEFINITION_ORDERING` (ADR 0019).
 */
export class TermView extends FateDataView<TermViewRow>()("Term")({
	...termViewFields,
	definitions: FateDataView.list(DefinitionView, {orderBy: viewOrderBy(DEFINITION_ORDERING)}),
}) {}

export const definitionDataView = DefinitionView.view;
export const termDataView = TermView.view;

export type Definition = WorkerEntity<typeof DefinitionView, "createdAt" | "updatedAt">;
export type Term = WorkerEntity<
	typeof TermView,
	"firstAt" | "lastEdit" | "lastActivityAt",
	{definitions?: Definition[]}
>;
