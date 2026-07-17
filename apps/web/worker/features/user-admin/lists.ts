/**
 * The user-admin root list resolver (#3200) — `userAdmin.list`, the gated user roster the
 * `kullanıcılar` console module reads. A paginated (`first`/`after` keyset), searchable
 * (`search` substring) admin read.
 *
 * Two gates, both enforced HERE (the pasaport reads are unconditional), mirroring
 * `pasaport/lists.ts`'s `emailDelivery.failing`:
 *   1. The `PHOENIX_USER_ADMIN` dark-ship flag (default-off, ADR 0083). Off ⇒ the invisible
 *      `Denied`, so the roster never leaks before release.
 *   2. `requireAdmin` (ADR 0107) — `yield* Admin` makes the read unreachable without the
 *      discharged grant, so a non-admin gets the SAME invisible `Denied`.
 *
 * The `role`/`banned` standing is JOINED past the gate, never read off the retired
 * `user.role` column: `banned` from the batched ban-state projection
 * (`Pasaport.banStatesForAdmin`), `role` from the `moderates` relation tuple
 * (`moderatorsAmong`) — one relation read per page, never a per-row `isModerator`.
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

/** Is the #3200 user-admin dark-ship flag on for this request? Safe-default `false` (dark). */
const userAdminOn = Effect.gen(function* () {
	const flags = yield* Flags;
	return yield* flags.getBoolean(PHOENIX_USER_ADMIN, false).pipe(provideRequestFlags);
});

// The post-gate roster read — `Admin`-gated in R (`requireAdmin` provides the grant).
// `yield* Admin` requires the proof; the roster is unreachable without a discharged grant.
// Exported so the gate + shaping can be exercised end to end in a unit test.
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
