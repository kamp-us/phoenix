/**
 * Flagship admin mutation resolver — `flag.setOverride`, the runtime flag-flip (admin-console
 * epic #2711, #2741). `Fate.mutation` def + `Effect.fn` pair (`.patterns/fate-effect-operations.md`).
 *
 * Two gates, both enforced HERE, mirroring `user.banUser`:
 *   1. The `phoenix-admin-console` dark-ship flag (`adminConsoleOn`, default-off, ADR 0083). Off ⇒
 *      the invisible `Denied` (like a non-admin call), so an unreleased flip never lands.
 *   2. `requireAdmin` (ADR 0107) — the write stamps the discharged `Admin` grant's account id
 *      (`adminOf`), never a client-supplied identity, so every prod flip is auditable by construction.
 *
 * The write appends ONE event to the append-only `flag_override_event` log (the store), never a
 * destructive update — the effective override is the latest-event projection (`flag-override.ts`).
 * After the write, the ack re-reads `Flags.getBoolean` for the key, which the runtime-override
 * wrapper short-circuits, so the returned `effective` (and a subsequent gate read) reflect the flip
 * (#2711 story 5). NOT fanned (`fate-live/fanned-mutations.ts`): the override log is an admin audit
 * surface, not a subscribed Post/Comment/Definition connection (mirrors `emailDelivery.mark`).
 */
import {Fate} from "@kampus/fate-effect";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {Admin, adminOf, requireAdmin} from "../kunye/admin.ts";
import {Denied} from "../kunye/errors.ts";
import {adminConsoleOn} from "./admin-gate.ts";
import {DECLARED_FLAGS} from "./declared-flags.ts";
import {UnknownFlagKey} from "./errors.ts";
import {FlagOverrideStore} from "./FlagOverrideStore.ts";
import {Flags} from "./Flags.ts";
import {provideRequestFlags} from "./FlagsContext.ts";
import {toFlagState} from "./shapers.ts";
import {FlagStateView} from "./views.ts";

// Set a flag's runtime override: the target `key` (validated against the declared-flags
// registry in the gated body) and the tri-state `state` (`on`/`off` force the effective
// value, `clear` lifts the override). A `Schema.Literal` union makes a malformed `state`
// an input-DECODE failure — the body never runs on a bad state. No `actor` arg: the acting
// admin is the discharged `Admin` grant's id, never client-supplied.
const SetOverrideInput = Schema.Struct({
	key: Schema.String,
	state: Schema.Literals(["on", "off", "clear"]),
});

export const mutations = {
	"flag.setOverride": Fate.mutation(
		{
			input: SetOverrideInput,
			type: FlagStateView,
			error: Schema.Union([Denied, UnknownFlagKey]),
		},
		Effect.fn("flag.setOverride")(function* ({input}) {
			if (!(yield* adminConsoleOn)) {
				return yield* Effect.fail(new Denied({message: "Bu işlem şu an kapalı."}));
			}
			return yield* requireAdmin(setOverrideGated(input));
		}),
	),
};

// The post-gate flip body — runnable only with an `Admin` `Grant` in R (`requireAdmin`
// provides it); `yield* adminOf(grant)` reads the authority-checked actor id the audit row
// is stamped with. An unknown/typo'd key fails `UnknownFlagKey` up front so the override log
// stays meaningful; otherwise the event is appended and the ack re-reads the (now override-
// applied) effective state.
const setOverrideGated = Effect.fn("flag.setOverrideGated")(function* (
	input: typeof SetOverrideInput.Type,
) {
	const grant = yield* Admin;
	const actorId = yield* adminOf(grant);

	const flag = DECLARED_FLAGS.find((f) => f.key === input.key);
	if (!flag) {
		return yield* new UnknownFlagKey({message: `Bilinmeyen bayrak: ${input.key}`});
	}

	const store = yield* FlagOverrideStore;
	yield* store.record({flagKey: flag.key, action: input.state, actorId});

	const flags = yield* Flags;
	const effective = yield* flags.getBoolean(flag.key, flag.defaultValue).pipe(provideRequestFlags);
	return toFlagState({
		key: flag.key,
		defaultValue: flag.defaultValue,
		effective,
		overridden: input.state !== "clear",
	});
});
