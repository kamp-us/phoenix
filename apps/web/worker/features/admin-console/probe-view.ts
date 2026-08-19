/**
 * The server-authoritative "may THIS caller open the admin console?" signal (#2740).
 * Producing the row at all IS the signal, so it carries no identity, capability list, or
 * roster — it is only ever reached past the `requireAdmin` gate, and a non-admin gets the
 * invisible `Denied` instead (ADR 0107 / ADR 0098 §2).
 */
import {FateDataView, type WorkerEntity} from "@kampus/fate-effect";
import type {ViewRow} from "../fate/view-types.ts";

export type AdminProbeViewRow = ViewRow<{id: string; admin: boolean}>;

export class AdminProbeView extends FateDataView<AdminProbeViewRow>()("AdminProbe")({
	id: true,
	admin: true,
} satisfies {[K in keyof AdminProbeViewRow]: true}) {}

export const adminProbeDataView = AdminProbeView.view;

export type AdminProbe = WorkerEntity<typeof AdminProbeView>;
