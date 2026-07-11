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
// `postDataView`). The `mecmuaFeed` root (#2500) is a `list(mecmuaPostDataView, …)`.
export const mecmuaPostDataView = MecmuaPostView.view;

/**
 * The subscribe/unsubscribe write receipt (#2500) — the minimal shape the
 * `mecmua.subscribe` / `mecmua.unsubscribe` mutations return (the `NotificationMarkReceipt`
 * idiom): `id` is the target author, `subscribed` the edge state AFTER the write. A
 * synthetic view (no fetch path) — the mutation delivers it inline, never re-fetched.
 */
export type MecmuaSubscriptionReceiptViewRow = ViewRow<{
	/** The target author id — the receipt's identity. */
	id: string;
	/** The edge state after the write: true ⇒ subscribed, false ⇒ unsubscribed. */
	subscribed: boolean;
}>;

export class MecmuaSubscriptionReceiptView extends FateDataView<MecmuaSubscriptionReceiptViewRow>()(
	"MecmuaSubscriptionReceipt",
)({
	id: true,
	subscribed: true,
} satisfies {[K in keyof MecmuaSubscriptionReceiptViewRow]: true}) {}

export const mecmuaSubscriptionReceiptDataView = MecmuaSubscriptionReceiptView.view;
export type MecmuaSubscriptionReceipt = WorkerEntity<typeof MecmuaSubscriptionReceiptView>;

// `createdAt`/`updatedAt`/`publishedAt` ride the standard timestamp correction (wire
// `string` / `string | null` → `Date` / `Date | null`); `StringToDate` preserves the
// draft-`null` on `publishedAt`, so no `Override` slot is needed.
export type MecmuaPost = WorkerEntity<
	typeof MecmuaPostView,
	"createdAt" | "updatedAt" | "publishedAt"
>;
