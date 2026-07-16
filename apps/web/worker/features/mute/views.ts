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

/**
 * `MutedMember` — one entry of the viewer's own manage-my-mutes list (#3114),
 * delivered inline by the `mute.listMine` list root (no by-id fetch path — a mute is
 * the muter's private state). `id` is the muted member id (the row identity + the
 * unmute target the UI passes to `mute.remove`); `username`/`displayName` are the
 * profile handle joined at the resolver so a row renders + offers an unmute, both
 * nullable for an un-bootstrapped member. `mutedAt` (ISO-8601) is the newest-first
 * order key. See `.patterns/fate-effect-data-views.md`.
 */
export type MutedMemberViewRow = ViewRow<{
	/** The muted member id — the row identity + the `mute.remove` unmute target. */
	id: string;
	/** The muted member's username (`null` for an un-bootstrapped member). */
	username: string | null;
	/** The muted member's display name (`null` when unset). */
	displayName: string | null;
	/** When the mute was set (ISO-8601) — the newest-first order key. */
	mutedAt: string;
}>;

export class MutedMemberView extends FateDataView<MutedMemberViewRow>()("MutedMember")({
	id: true,
	username: true,
	displayName: true,
	mutedAt: true,
} satisfies {[K in keyof MutedMemberViewRow]: true}) {}

export const mutedMemberDataView = MutedMemberView.view;
export type MutedMember = WorkerEntity<typeof MutedMemberView>;
