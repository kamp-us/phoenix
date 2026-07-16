/** mute's contribution to the one fate config. See `../fate/module.ts`. */
import {Fate} from "@kampus/fate-effect";
import {list} from "@nkzw/fate/server";
import type {FateModule, FateRootsRecord} from "../fate/module.ts";
import {lists} from "./lists.ts";
import {mutations} from "./mutations.ts";
import {MutedMemberView, MuteReceiptView, mutedMemberDataView} from "./views.ts";

// Both mute entities are delivered inline (never read by id): `MuteReceipt` by the
// `mute.set` / `mute.remove` mutations, `MutedMember` by the `mute.listMine` list root
// (#3114). A `syntheticSource` (no by-id fetch path) makes each view-reachable in codegen
// with zero capabilities — the mecmua `MecmuaSubscriptionReceiptView` / `ReportReceipt`
// escape hatch (`.patterns/fate-effect-sources.md`).
const muteReceiptSource = Fate.syntheticSource(MuteReceiptView);
const mutedMemberSource = Fate.syntheticSource(MutedMemberView);

const roots: FateRootsRecord = {
	// The viewer's manage-my-mutes list (#3114) — a `CurrentUser`-gated, flag-dark list
	// root; the `mute.listMine` resolver owns the newest-first keyset order + muter scoping.
	"mute.listMine": list(mutedMemberDataView),
};

export const fateModule = {
	lists,
	mutations,
	sources: [muteReceiptSource, mutedMemberSource],
	roots,
} satisfies FateModule;
