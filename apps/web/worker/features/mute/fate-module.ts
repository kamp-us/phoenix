/** mute's contribution to the one fate config. See `../fate/module.ts`. */
import {Fate} from "@kampus/fate-effect";
import type {FateModule} from "../fate/module.ts";
import {mutations} from "./mutations.ts";
import {MuteReceiptView} from "./views.ts";

// `mute.set` / `mute.remove` return `MuteReceiptView` inline, so the entity needs a
// source to be view-reachable in codegen. A `syntheticSource` (no by-id fetch path) is
// the minimal footprint — the mutation delivers the receipt in its response (the mecmua
// `MecmuaSubscriptionReceiptView` idiom).
const muteReceiptSource = Fate.syntheticSource(MuteReceiptView);

export const fateModule = {
	mutations,
	sources: [muteReceiptSource],
} satisfies FateModule;
