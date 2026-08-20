/**
 * The viewer's own çaylak-visibility preference as a synthetic singleton (#6422,
 * epic #4306) — the `NotificationUnread` shape: one stable id, no fetch path, produced
 * only by the `caylakVisibility.mine` read and the two opt mutations, so a mutation's
 * result reconciles the read's cached record with no refetch. Data views are the
 * schema (ADR 0018); see `.patterns/fate-effect-data-views.md`.
 *
 * There is exactly one of these per viewer and it is never addressed by another
 * account's id — the resolvers key it off `CurrentUser`, which is why the id is a
 * constant and not the user id.
 */
import {FateDataView, type WorkerEntity} from "@kampus/fate-effect";
import type {ViewRow} from "../fate/view-types.ts";

/** The singleton id — the viewer's own preference, never another account's. */
export const CAYLAK_VISIBILITY_PREFERENCE_ID = "mine";

export type CaylakVisibilityPreferenceViewRow = ViewRow<{
	id: string;
	/** Has this viewer opted into seeing çaylak contributions in place? */
	optedIn: boolean;
	/** When the opt-in was set (ISO-8601); `null` when opted out. */
	optedInAt: string | null;
}>;

export class CaylakVisibilityPreferenceView extends FateDataView<CaylakVisibilityPreferenceViewRow>()(
	"CaylakVisibilityPreference",
)({
	id: true,
	optedIn: true,
	optedInAt: true,
} satisfies {[K in keyof CaylakVisibilityPreferenceViewRow]: true}) {}

export const caylakVisibilityPreferenceDataView = CaylakVisibilityPreferenceView.view;
export type CaylakVisibilityPreference = WorkerEntity<typeof CaylakVisibilityPreferenceView>;
