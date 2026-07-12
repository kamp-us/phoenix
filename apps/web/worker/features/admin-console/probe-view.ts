/**
 * `AdminProbe` — the admin-console shell's one data view (#2740, epic #2711): the
 * server-authoritative "may THIS caller open the admin console?" signal the SPA reads to
 * decide whether to mount+fetch the lazy console bundle. A synthetic singleton (there is
 * only ever the one probe row per request, keyed `id: "admin-probe"`), mirroring
 * `stats/LandingStats` / `funnel/FunnelSummary`.
 *
 * Carries ONLY the fact that the gate passed — no identity, no capability list, no admin
 * roster. Producing this row at all is the signal; it is only ever reached past the
 * `requireAdmin` gate + the `phoenix-admin-console` flag (`queries.ts`), so a non-admin
 * gets the invisible `Denied` (indistinguishable from not-signed-in, ADR 0107 / ADR 0098
 * §2) rather than a row that leaks admin-ness.
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
