/**
 * Sözlük fate data views (ADR 0018/0019; see `.patterns/fate-effect-data-views.md` and
 * `.patterns/fate-connections.md`). Everything derives from one source so the view and
 * the service keyset can't drift.
 */
import {FateDataView, type WorkerEntity} from "@kampus/fate-effect";
import {viewOrderBy} from "../../db/ordering.ts";
import type {ViewRow} from "../fate/view-types.ts";
import {definitionViewFields} from "./definition-fields.ts";
import {DEFINITION_ORDERING} from "./ordering.ts";
import type {DefinitionRow} from "./Sozluk.ts";
import {type TermSummaryRow, termViewFields} from "./term-fields.ts";

// Mapped restatements so the rows are `Record<string, unknown>`-assignable (the plain row
// interfaces are not). Exported because `Fate.source` surfaces the row type (TS2883).
export type DefinitionViewRow = ViewRow<DefinitionRow>;
export type TermViewRow = ViewRow<TermSummaryRow>;

export class DefinitionView extends FateDataView<DefinitionViewRow>()("Definition")(
	definitionViewFields,
) {}

/**
 * The view is over `TermSummaryRow`; the detail-page `term(slug)` resolver reshapes its
 * `TermPage` into the same shape.
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
