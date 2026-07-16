/**
 * `mute.listMine` — the manage-my-mutes read model (#3114, epic #2035): the viewer's
 * own muted members, newest-mute-first, forward keyset-paginated. Gated on
 * `CurrentUser` (an anonymous caller is rejected the invisible `Unauthorized` before
 * any read) and behind the default-off `member-mute` flag (off ⇒ `MuteDisabled`, so
 * the whole mute surface stays dark uniformly — the same containment the `mute.set` /
 * `mute.remove` write path uses, see `errors.ts`).
 *
 * A member only ever pages their OWN mutes: the muter scope is structural in
 * `Mute.listMine` (`muter_id` rides every predicate). Each row is hydrated with the
 * muted member's profile handle joined from pasaport in ONE batched read (the divan
 * roster idiom) — enough for a UI to render the row and offer a per-row unmute
 * (`mute.remove` keyed on the row `id`). The read model only; the list UI + the
 * unmute button are the reachability sibling, the unmute write is `mute.remove`.
 */
import {CurrentUser, Fate, Unauthorized} from "@kampus/fate-effect";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {MEMBER_MUTE} from "../../../src/flags/keys.ts";
import {toConnection} from "../fate/connection.ts";
import {Flags} from "../flagship/Flags.ts";
import {provideRequestFlags} from "../flagship/FlagsContext.ts";
import {Pasaport} from "../pasaport/Pasaport.ts";
import {MuteDisabled} from "./errors.ts";
import {Mute, type MutedMemberRow} from "./Mute.ts";
import type {MutedMember} from "./views.ts";
import {MutedMemberView} from "./views.ts";

const ListMineArgs = Schema.Struct({
	first: Schema.optional(Schema.Number),
	after: Schema.optional(Schema.String),
});

/** Is the member-mute surface on for this request? Safe-default `false` (ships dark). */
const memberMuteOn = Effect.gen(function* () {
	const flags = yield* Flags;
	return yield* flags.getBoolean(MEMBER_MUTE, false).pipe(provideRequestFlags);
});

export const lists = {
	"mute.listMine": Fate.list(
		{
			args: ListMineArgs,
			type: MutedMemberView,
			error: Schema.Union([Unauthorized, MuteDisabled]),
		},
		Effect.fn("mute.listMine")(function* ({args}) {
			const user = yield* CurrentUser.required;
			if (!(yield* memberMuteOn)) {
				return yield* new MuteDisabled({message: "sustur şu an kapalı"});
			}

			const mute = yield* Mute;
			const page = yield* mute.listMine(user.id, {
				...(args.first !== undefined ? {first: args.first} : {}),
				...(args.after !== undefined ? {after: args.after} : {}),
			});

			// One batched identity read for the whole page (never a per-row by-id): a
			// member absent from `user_profile` simply has no entry and renders with a
			// null handle client-side.
			const pasaport = yield* Pasaport;
			const identities = yield* pasaport.getProfileIdentitiesByIds(
				page.rows.map((row) => row.mutedId),
			);
			const handles = new Map(identities.map((row) => [row.userId, row]));

			return toConnection<MutedMemberRow, MutedMember>(
				page,
				(row) => row.mutedId,
				(row) => {
					const identity = handles.get(row.mutedId);
					return {
						__typename: "MutedMember",
						id: row.mutedId,
						username: identity?.username ?? null,
						displayName: identity?.displayName ?? null,
						mutedAt: row.mutedAt.toISOString(),
					};
				},
			);
		}),
	),
};
