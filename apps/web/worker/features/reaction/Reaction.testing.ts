/**
 * A no-reactions `Reaction` double, discharging the `R` requirement that `PanoLive` /
 * `SozlukLive` reads pick up from stamping the reaction aggregate (#1862). The write
 * paths die if reached — they belong to `Reaction.unit.test.ts`, not to the
 * connection/validation tests this serves.
 */
import {Effect, Layer} from "effect";
import type {ReactionEmoji} from "../../db/reaction-emoji.ts";
import {Reaction, type ReactionAggregate} from "./Reaction.ts";

export const ReactionStub = Layer.succeed(Reaction, {
	react: () => Effect.die(new Error("stub Reaction must not react on this path")),
	readMine: () => Effect.succeed(new Map<string, ReactionEmoji>()),
	readAggregate: () => Effect.succeed(new Map<string, ReactionAggregate>()),
	clearTarget: () => Effect.void,
} satisfies typeof Reaction.Service);
