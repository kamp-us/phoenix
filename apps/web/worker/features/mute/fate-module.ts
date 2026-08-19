/** mute's contribution to the one fate config. See `../fate/module.ts`. */
import {Fate} from "@kampus/fate-effect";
import {list} from "@nkzw/fate/server";
import type {FateModule, FateRootsRecord} from "../fate/module.ts";
import {lists} from "./lists.ts";
import {mutations} from "./mutations.ts";
import {MutedMemberView, MuteReceiptView, mutedMemberDataView} from "./views.ts";

// Both mute entities are delivered inline, never read by id, so a `syntheticSource`
// makes each view-reachable in codegen with zero capabilities
// (.patterns/fate-effect-sources.md).
const muteReceiptSource = Fate.syntheticSource(MuteReceiptView);
const mutedMemberSource = Fate.syntheticSource(MutedMemberView);

const roots: FateRootsRecord = {
	// `CurrentUser`-gated and flag-dark; the resolver owns the keyset order and muter
	// scoping (#3114).
	"mute.listMine": list(mutedMemberDataView),
};

export const fateModule = {
	lists,
	mutations,
	sources: [muteReceiptSource, mutedMemberSource],
	roots,
} satisfies FateModule;
