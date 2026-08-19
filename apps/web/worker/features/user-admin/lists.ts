/**
 * The user-admin roster read (#3200). Both gates are enforced HERE, because the pasaport
 * reads are unconditional: the `PHOENIX_USER_ADMIN` dark-ship flag (ADR 0083) and
 * `requireAdmin` (ADR 0107), each failing with the SAME invisible `Denied`. `role`/`banned`
 * are joined past the gate, never read off the retired `user.role` column.
 */
import {Fate} from "@kampus/fate-effect";
import type {ConnectionResult} from "@nkzw/fate/server";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {PHOENIX_USER_ADMIN} from "../../../src/flags/keys.ts";
import {Flags} from "../flagship/Flags.ts";
import {provideRequestFlags} from "../flagship/FlagsContext.ts";
import {Admin, requireAdmin} from "../kunye/admin.ts";
import {Denied} from "../kunye/errors.ts";
import {moderatorsAmong} from "../kunye/moderate.ts";
import {Pasaport} from "../pasaport/Pasaport.ts";
import {toUserAdminRow} from "./shapers.ts";
import type {UserAdminEntity} from "./views.ts";
import {UserAdminView} from "./views.ts";

export const UserAdminListArgs = Schema.Struct({
	first: Schema.optional(Schema.Number),
	after: Schema.optional(Schema.String),
	/** A case-insensitive substring over username/email/name; absent ⇒ the whole roster. */
	search: Schema.optional(Schema.String),
});

type UserAdminListArgsType = Schema.Schema.Type<typeof UserAdminListArgs>;

const userAdminOn = Effect.gen(function* () {
	const flags = yield* Flags;
	return yield* flags.getBoolean(PHOENIX_USER_ADMIN, false).pipe(provideRequestFlags);
});

// `yield* Admin` requires the proof, so the roster is unreachable without a discharged
// grant. Exported so the gate + shaping can be exercised end to end in a unit test.
export const userAdminListGated = Effect.fn("userAdmin.listGated")(function* (
	args: UserAdminListArgsType,
) {
	yield* Admin;
	const pasaport = yield* Pasaport;
	const page = yield* pasaport.listUsersForAdmin({
		search: args.search ?? null,
		after: args.after ?? null,
		...(args.first !== undefined ? {first: args.first} : {}),
	});
	const ids = page.rows.map((row) => row.id);
	// One batched ban-state read + one `moderates` relation read for the whole page —
	// never a per-row `getBanState` / `isModerator` (an in-page N+1).
	const banStates = yield* pasaport.banStatesForAdmin(ids);
	const mods = yield* moderatorsAmong(ids);
	return {
		items: page.rows.map((row) => {
			const node = toUserAdminRow(row, {
				banned: banStates.get(row.id)?.banned ?? false,
				isModerator: mods.has(row.id),
			});
			return {cursor: node.id, node};
		}),
		pagination: {
			hasNext: page.hasNextPage,
			hasPrevious: false,
			...(page.endCursor ? {nextCursor: page.endCursor} : {}),
		},
	} satisfies ConnectionResult<UserAdminEntity>;
});

export const lists = {
	"userAdmin.list": Fate.list(
		{
			args: UserAdminListArgs,
			type: UserAdminView,
			error: Schema.Union([Denied]),
		},
		Effect.fn("userAdmin.list")(function* ({args}) {
			if (!(yield* userAdminOn)) {
				return yield* Effect.fail(new Denied({message: "Bu işlem şu an kapalı."}));
			}
			return yield* requireAdmin(userAdminListGated(args));
		}),
	),
};
