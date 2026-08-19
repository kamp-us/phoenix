/**
 * `caylakVisibility.optIn` / `caylakVisibility.optOut` (#6422, epic #4306) — the two
 * writes behind the yazar's "çaylak katkılarını yerinde göster" toggle. The account
 * written is always the authenticated caller's own (`CurrentUser`, never a wire
 * input), so there is no shape by which one account sets another's preference.
 *
 * Three gates, in this order: signed in, the flag is on (off ⇒ the invisible
 * {@link Denied}, so the write path is unreachable while the feature is dark), and —
 * on opt-IN only — the yazar floor discharged through {@link requireSetCaylakVisibility}
 * against a tier read fresh from `Kunye.tierOf`. Opting out is normal-auth: see
 * `SetCaylakVisibility.ts` for why the floor is asymmetric.
 *
 * NOT fanned: this writes one account's private preference, in no subscribed
 * `/fate/live` connection, and nothing reads it to change what anyone sees yet —
 * classified `fanned: false` in `fate-live/fanned-mutations.ts`.
 */
import {CurrentUser, Fate, Unauthorized} from "@kampus/fate-effect";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {Denied, RequiresLevel} from "../kunye/errors.ts";
import {CaylakVisibility} from "./CaylakVisibility.ts";
import {requireCaylakVisibilityOn} from "./gate.ts";
import {requireSetCaylakVisibility, SetCaylakVisibility} from "./SetCaylakVisibility.ts";
import {toPreference} from "./shapers.ts";
import {CaylakVisibilityPreferenceView} from "./views.ts";

// Both writes are argument-free by construction: the only account either can write is
// `CurrentUser`'s, so an empty input is the wire shape that makes "set someone else's
// preference" unsendable rather than merely refused.
const NoInput = Schema.Struct({});

export const mutations = {
	"caylakVisibility.optIn": Fate.mutation(
		{
			input: NoInput,
			type: CaylakVisibilityPreferenceView,
			error: Schema.Union([Unauthorized, Denied, RequiresLevel]),
		},
		Effect.fn("caylakVisibility.optIn")(function* () {
			const user = yield* CurrentUser.required;
			yield* requireCaylakVisibilityOn;
			return yield* requireSetCaylakVisibility(
				Effect.gen(function* () {
					yield* SetCaylakVisibility;
					const caylakVisibility = yield* CaylakVisibility;
					return toPreference(yield* caylakVisibility.set({userId: user.id, value: true}));
				}),
			);
		}),
	),
	"caylakVisibility.optOut": Fate.mutation(
		{
			input: NoInput,
			type: CaylakVisibilityPreferenceView,
			error: Schema.Union([Unauthorized, Denied]),
		},
		Effect.fn("caylakVisibility.optOut")(function* () {
			const user = yield* CurrentUser.required;
			yield* requireCaylakVisibilityOn;
			const caylakVisibility = yield* CaylakVisibility;
			return toPreference(yield* caylakVisibility.set({userId: user.id, value: false}));
		}),
	),
};
