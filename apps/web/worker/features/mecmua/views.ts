/**
 * mecmua fate data views. Data views are the schema (ADR 0018); see
 * `.patterns/fate-effect-data-views.md`.
 */
import {FateDataView, type WorkerEntity} from "@kampus/fate-effect";
import type {ViewRow} from "../fate/view-types.ts";
import {type MecmuaPostRow, mecmuaPostViewFields} from "./post-fields.ts";

// A `Record<string, unknown>`-assignable restatement of the service row (the plain row
// interface is not), so `Fate.source` declarations can name the row type (TS2883).
export type MecmuaPostViewRow = ViewRow<MecmuaPostRow>;

// Fields derive from `post-fields.ts`'s column→field map, so they can't drift from the
// row mapper (#1166).
export class MecmuaPostView extends FateDataView<MecmuaPostViewRow>()("MecmuaPost")(
	mecmuaPostViewFields,
) {}

export const mecmuaPostDataView = MecmuaPostView.view;

/**
 * The subscribe/unsubscribe write receipt (#2500). Synthetic — no fetch path; the
 * mutation delivers it inline and it is never re-fetched.
 */
export type MecmuaSubscriptionReceiptViewRow = ViewRow<{
	/** The target author id. */
	id: string;
	/** The edge state AFTER the write. */
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

// `StringToDate` preserves the draft-`null` on `publishedAt`, so no `Override` is needed.
export type MecmuaPost = WorkerEntity<
	typeof MecmuaPostView,
	"createdAt" | "updatedAt" | "publishedAt"
>;
