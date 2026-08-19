/**
 * Mute fate data views (#3112). `MuteReceipt` is synthetic — no fetch path, delivered inline by
 * the `mute.set` / `mute.remove` mutations, never re-fetched: `id` is the muted member,
 * `isMuted` the muter's presence over them AFTER the write, `changed` false on an idempotent
 * no-op. Data views are the schema (ADR 0018); see `.patterns/fate-effect-data-views.md`.
 */
import {FateDataView, type WorkerEntity} from "@kampus/fate-effect";
import type {ViewRow} from "../fate/view-types.ts";

export type MuteReceiptViewRow = ViewRow<{
	id: string;
	isMuted: boolean;
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
 * One entry of the viewer's own manage-my-mutes list (#3114), delivered inline by the
 * `mute.listMine` list root — a mute is the muter's private state, so there is no by-id fetch
 * path. `id` is the unmute target `mute.remove` takes; `username`/`displayName` are the profile
 * handle joined at the resolver, both null for an un-bootstrapped member; `mutedAt` (ISO-8601)
 * is the newest-first order key.
 */
export type MutedMemberViewRow = ViewRow<{
	id: string;
	username: string | null;
	displayName: string | null;
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
