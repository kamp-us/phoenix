/** The one domain-state → wire-row shaper for this feature. */
import type {CaylakVisibilityState} from "./CaylakVisibility.ts";
import {CAYLAK_VISIBILITY_PREFERENCE_ID, type CaylakVisibilityPreference} from "./views.ts";

export const toPreference = (state: CaylakVisibilityState): CaylakVisibilityPreference => ({
	__typename: "CaylakVisibilityPreference",
	id: CAYLAK_VISIBILITY_PREFERENCE_ID,
	optedIn: state.optedIn,
	optedInAt: state.optedIn ? state.setAt.toISOString() : null,
});
