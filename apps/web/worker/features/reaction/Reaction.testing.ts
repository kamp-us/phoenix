/**
 * `ReactionStub` — a no-reactions `Reaction` service double for the unit tests that
 * build `PanoLive` / `SozlukLive` over a substituted `Drizzle` seam. Those services
 * now stamp the reaction aggregate on their reads (`Reaction.readAggregate`, #1862),
 * so a test that provides only `Vote`/`Bookmark`/`Drizzle` leaves `Reaction`
 * unsatisfied in `R`. This stub discharges it: `readAggregate` / `readMine` return
 * empty (no reactions), so the aggregate field degrades to the empty aggregate and no
 * extra DB read happens through the reaction service — the react/change/retract write
 * paths are the domain tests' concern (`Reaction.unit.test.ts`), never these
 * connection/validation tests, so they die if reached.
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
