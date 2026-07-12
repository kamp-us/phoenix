/**
 * Flagship admin fate data views (admin-console epic #2711, #2741). The `FlagState` view is
 * the per-flag row the `requireAdmin`-gated `flags.state` roll-up and the `flag.setOverride`
 * mutation ack both produce: a declared flag's key, its declared default, its current effective
 * state (real Flagship evaluation with any active runtime override applied), and whether an
 * override is currently forcing it. It carries ONLY flag state — no session, no PII — and is only
 * ever produced past the `requireAdmin` gate + the `phoenix-admin-console` dark-ship flag, so it
 * never leaks (the `BanState` / `EmailDeliveryState` admin-view precedent).
 */
import {FateDataView, type WorkerEntity} from "@kampus/fate-effect";
import type {ViewRow} from "../fate/view-types.ts";

// `id` === the flag key (the client normalization key), so the roll-up rows and the
// per-flag mutation ack reconcile the SAME entity. `effective` is what a real gate would
// read for this flag right now (override-applied); `overridden` distinguishes a
// forced-`false` override from a real-evaluation `false`.
export type FlagStateViewRow = ViewRow<{
	id: string;
	key: string;
	defaultValue: boolean;
	effective: boolean;
	overridden: boolean;
}>;

export class FlagStateView extends FateDataView<FlagStateViewRow>()("FlagState")({
	id: true,
	key: true,
	defaultValue: true,
	effective: true,
	overridden: true,
} satisfies {[K in keyof FlagStateViewRow]: true}) {}

export const flagStateDataView = FlagStateView.view;

export type FlagStateEntity = WorkerEntity<typeof FlagStateView>;
