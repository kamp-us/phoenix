/**
 * Member-mute (sustur) write-path mutation resolvers (#3112, epic #2035) — the
 * `mute.set` / `mute.remove` acts, gated behind the default-off `member-mute` flag
 * (ADR 0083, the mecmua write-path dark-ship shape): with the flag off both fail
 * {@link MuteDisabled}, so the write path is unreachable even if a client bypasses
 * the (not-yet-built) UI. Domain validation + the DB write live in {@link Mute} (ADR
 * 0013); this layer resolves the identity, the flag, and delegates to `Mute.set`.
 *
 * The muter is always the authenticated caller acting on themselves — `CurrentUser`
 * is the muter (`muterId`), never a wire input, so a client cannot mute *on behalf
 * of* another member. An anonymous caller is rejected `Unauthorized` before any read.
 * `mute.set` mutes (`value: true`), `mute.remove` un-mutes (`value: false`); both are
 * idempotent (a matching state is a `changed: false` no-op, decided in `Mute.set`).
 *
 * NOT fanned: a mute masks only the muter's OWN reads (the read-mask is a sibling
 * slice), so it writes no Post/Comment/Definition in a subscribed cross-client
 * connection and publishes no `/fate/live` invalidation — classified `fanned: false`
 * with that rationale in `fate-live/fanned-mutations.ts` (the `post.save` per-viewer
 * precedent). See ADR 0155.
 */
import {CurrentUser, Fate, Unauthorized} from "@kampus/fate-effect";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {MEMBER_MUTE} from "../../../src/flags/keys.ts";
import {UserId} from "../../lib/ids.ts";
import {Flags} from "../flagship/Flags.ts";
import {provideRequestFlags} from "../flagship/FlagsContext.ts";
import {MuteDisabled, SelfMuteRejected} from "./errors.ts";
import {Mute, type MuteSetResult} from "./Mute.ts";
import {type MuteReceipt, MuteReceiptView} from "./views.ts";

/** Is the member-mute write path on for this request? Safe-default `false` (ships dark). */
const memberMuteOn = Effect.gen(function* () {
	const flags = yield* Flags;
	return yield* flags.getBoolean(MEMBER_MUTE, false).pipe(provideRequestFlags);
});

/** Stamp the wire `__typename` onto the service result — the one mute write-path shaper. */
const toReceipt = (r: MuteSetResult): MuteReceipt => ({
	__typename: "MuteReceipt",
	id: r.mutedId,
	isMuted: r.isMuted,
	changed: r.changed,
});

// Branded wire input (type-only, byte-identical decode): `mutedId` arrives tagged
// `UserId`, so a transposed service call is a compile error (the mecmua #2700 idiom).
const MuteInput = Schema.Struct({
	mutedId: UserId,
});

/** Resolve one mute presence write to `value`, shared by `mute.set` / `mute.remove`. */
const setPresence = (value: boolean) =>
	Effect.fn(value ? "mute.set" : "mute.remove")(function* ({input}: {input: {mutedId: UserId}}) {
		const user = yield* CurrentUser.required;
		if (!(yield* memberMuteOn)) {
			return yield* new MuteDisabled({message: "sustur şu an kapalı"});
		}
		const mute = yield* Mute;
		const result = yield* mute.set({muterId: user.id, mutedId: input.mutedId, value});
		return toReceipt(result);
	});

export const mutations = {
	"mute.set": Fate.mutation(
		{
			input: MuteInput,
			type: MuteReceiptView,
			error: Schema.Union([Unauthorized, MuteDisabled, SelfMuteRejected]),
		},
		setPresence(true),
	),
	"mute.remove": Fate.mutation(
		{
			input: MuteInput,
			type: MuteReceiptView,
			error: Schema.Union([Unauthorized, MuteDisabled, SelfMuteRejected]),
		},
		setPresence(false),
	),
};
