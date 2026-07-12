/** flagship's contribution to the one fate config (#2741). See `../fate/module.ts`. */
import {list} from "@nkzw/fate/server";
import type {FateModule, FateRootsRecord} from "../fate/module.ts";
import {lists} from "./lists.ts";
import {mutations} from "./mutations.ts";
import {flagStateSource} from "./sources.ts";
import {flagStateDataView} from "./views.ts";

const roots: FateRootsRecord = {
	// The admin flag-state roll-up (#2741) — `requireAdmin`-gated + behind `phoenix-admin-console`;
	// the `flags.state` list resolver owns the gate.
	"flags.state": list(flagStateDataView),
};

export const fateModule = {
	mutations,
	lists,
	sources: [flagStateSource],
	roots,
} satisfies FateModule;
