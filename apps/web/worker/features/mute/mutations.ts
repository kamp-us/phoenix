/**
 * Member-mute (sustur) write-path mutation resolvers (#3112, epic #2035), gated behind the
 * default-off `member-mute` flag (ADR 0083) so the write path is unreachable even if a client
 * bypasses the UI. Domain validation + the DB write live in {@link Mute} (ADR 0013).
 *
 * The muter is always the authenticated caller — `CurrentUser`, never a wire input, so a client
 * cannot mute *on behalf of* another member.
 *
 * NOT fanned: a mute masks only the muter's OWN reads, so it publishes no `/fate/live`
 * invalidation — classified `fanned: false` in `fate-live/fanned-mutations.ts` (ADR 0155).
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

const memberMuteOn = Effect.gen(function* () {
	const flags = yield* Flags;
	return yield* flags.getBoolean(MEMBER_MUTE, false).pipe(provideRequestFlags);
});

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
