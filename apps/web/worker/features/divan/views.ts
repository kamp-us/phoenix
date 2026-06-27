/**
 * The divan fate views (#1287, epic #1202) — both private, gated surfaces with NO
 * source fetch path: each is delivered inline by its `divan.*` list resolver (the
 * `report.listOpen` / `OpenReport` shape), so its source is a capability-less
 * `Fate.syntheticSource` (view-reachable, no by-id read).
 *
 *   - {@link DivanCaylakView} — one roster row: a çaylak with pending work + the
 *     per-kind counts. `id` is the author id (so the client joins to the user).
 *   - {@link DivanBacklogItemView} — one sandboxed backlog item (the detail-view
 *     payload). `id` is `<kind>:<itemId>` so the three kinds never collide in one
 *     connection.
 */
import {FateDataView, type WorkerEntity} from "@kampus/fate-effect";
import type {ViewRow} from "../fate/view-types.ts";
import type {DivanItemKind} from "./roster.ts";

export type DivanCaylakViewRow = ViewRow<{
	id: string;
	authorId: string;
	definitionCount: number;
	postCount: number;
	commentCount: number;
	totalCount: number;
}>;

export class DivanCaylakView extends FateDataView<DivanCaylakViewRow>()("DivanCaylak")({
	id: true,
	authorId: true,
	definitionCount: true,
	postCount: true,
	commentCount: true,
	totalCount: true,
}) {}

export const divanCaylakDataView = DivanCaylakView.view;

export type DivanCaylak = WorkerEntity<typeof DivanCaylakView>;

export type DivanBacklogItemViewRow = ViewRow<{
	id: string;
	kind: DivanItemKind;
	authorId: string;
	createdAt: string;
	preview: string;
}>;

export class DivanBacklogItemView extends FateDataView<DivanBacklogItemViewRow>()(
	"DivanBacklogItem",
)({
	id: true,
	kind: true,
	authorId: true,
	createdAt: true,
	preview: true,
}) {}

export const divanBacklogItemDataView = DivanBacklogItemView.view;

export type DivanBacklogItem = WorkerEntity<typeof DivanBacklogItemView>;
