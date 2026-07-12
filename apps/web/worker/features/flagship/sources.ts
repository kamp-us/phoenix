/**
 * Flagship admin fate sources (#2741). `FlagState` has no by-id fetch path — it is produced
 * ONLY past the `requireAdmin` gate, by the `flags.state` roll-up (delivered inline) and the
 * `flag.setOverride` mutation ack, never a public by-id load (a by-id source would be an
 * ungated leak of flag state). Registered with ZERO capabilities so source-completeness
 * accepts the view-reachable result type; mirrors `banStateSource` / `failingAddressSource`.
 */
import {Fate} from "@kampus/fate-effect";
import {FlagStateView} from "./views.ts";

export const flagStateSource = Fate.syntheticSource(FlagStateView);
