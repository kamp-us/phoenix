/**
 * `caylakVisibility.mine` — the viewer's OWN çaylak-visibility preference (#6422,
 * epic #4306). There is no argument and no id input: the account read is
 * `CurrentUser`'s, so no wire shape exists by which one account reads another's
 * preference.
 *
 * Never fails. A dark flag and a signed-out caller both resolve "not opted in", each
 * short-circuiting before the D1 read — the `bildirim.unreadCount` well-formed-zero
 * shape, so a client can render the settings row without an error rail.
 */
import {CurrentUser, Fate} from "@kampus/fate-effect";
import {Effect} from "effect";
import {CaylakVisibility} from "./CaylakVisibility.ts";
import {caylakVisibilityOn} from "./gate.ts";
import {toPreference} from "./shapers.ts";

const OPTED_OUT = toPreference({optedIn: false});

export const queries = {
	"caylakVisibility.mine": Fate.query(
		{type: "CaylakVisibilityPreference"},
		Effect.fn("caylakVisibility.mine")(function* () {
			if (!(yield* caylakVisibilityOn)) return OPTED_OUT;
			const {user} = yield* CurrentUser;
			if (!user?.id) return OPTED_OUT;
			const caylakVisibility = yield* CaylakVisibility;
			return toPreference(yield* caylakVisibility.read(user.id));
		}),
	),
};
