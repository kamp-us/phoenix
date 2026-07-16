/**
 * Mute fate data view (#3112) — the write receipt the `mute.set` / `mute.remove`
 * mutations return inline (the mecmua `MecmuaSubscriptionReceiptView` idiom): a
 * synthetic view with no fetch path, delivered by the mutation, never re-fetched.
 * `id` is the muted member (the receipt's identity), `isMuted` the muter's presence
 * over them AFTER the write, `changed` false on an idempotent no-op. Data views are
 * the schema (ADR 0018); see `.patterns/fate-effect-data-views.md`.
 */
import {FateDataView, type WorkerEntity} from "@kampus/fate-effect";
import type {ViewRow} from "../fate/view-types.ts";

export type MuteReceiptViewRow = ViewRow<{
	/** The muted member id — the receipt's identity. */
	id: string;
	/** The muter's mute presence over `id` after the write. */
	isMuted: boolean;
	/** `false` on an idempotent no-op (state already matched intent). */
	changed: boolean;
}>;

export class MuteReceiptView extends FateDataView<MuteReceiptViewRow>()("MuteReceipt")({
	id: true,
	isMuted: true,
	changed: true,
} satisfies {[K in keyof MuteReceiptViewRow]: true}) {}

export const muteReceiptDataView = MuteReceiptView.view;
export type MuteReceipt = WorkerEntity<typeof MuteReceiptView>;
