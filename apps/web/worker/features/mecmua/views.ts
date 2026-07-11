/**
 * mecmua fate data views (epic #2467, #2463). `MecmuaPostView` is the read model
 * for a long-form mecmua post — its static `view` is the kernel `dataView()` output
 * and `WorkerEntity<>` derives the worker-side type. Mirrors the pano
 * `PostView`/`FateDataView` idiom (`features/pano/views.ts`). Data views are the
 * schema (ADR 0018); see `.patterns/fate-effect-data-views.md`.
 */
import {FateDataView, type WorkerEntity} from "@kampus/fate-effect";
import type {ViewRow} from "../fate/view-types.ts";
import {type MecmuaPostRow, mecmuaPostViewFields} from "./post-fields.ts";

// `Record<string, unknown>`-assignable restatement of the service row (the plain
// row interface is not), so `Fate.source` declarations over this view can name the
// row type (TS2883 portability), mirroring pano's `PostViewRow`.
export type MecmuaPostViewRow = ViewRow<MecmuaPostRow>;

// The field set derives from `post-fields.ts`'s column→field map, so it can't drift
// from the row mapper (#1166).
export class MecmuaPostView extends FateDataView<MecmuaPostViewRow>()("MecmuaPost")(
	mecmuaPostViewFields,
) {}

// Kernel view value for the fate `Root` map + cross-feature surfaces (as pano's
// `postDataView`); no mecmua root is wired yet (#2496 lands storage + read-model only).
export const mecmuaPostDataView = MecmuaPostView.view;

// `createdAt`/`updatedAt`/`publishedAt` ride the standard timestamp correction (wire
// `string` / `string | null` → `Date` / `Date | null`); `StringToDate` preserves the
// draft-`null` on `publishedAt`, so no `Override` slot is needed.
export type MecmuaPost = WorkerEntity<
	typeof MecmuaPostView,
	"createdAt" | "updatedAt" | "publishedAt"
>;
