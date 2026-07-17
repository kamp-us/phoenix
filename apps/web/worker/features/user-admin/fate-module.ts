/** user-admin's contribution to the one fate config. See `../fate/module.ts`. */
import {list} from "@nkzw/fate/server";
import type {FateModule, FateRootsRecord} from "../fate/module.ts";
import {lists} from "./lists.ts";
import {userAdminSource} from "./sources.ts";
import {userAdminDataView} from "./views.ts";

const roots: FateRootsRecord = {
	// The gated admin user roster (#3200) — `requireAdmin`-gated + behind
	// `phoenix-user-admin`; the `userAdmin.list` list resolver owns both gates.
	"userAdmin.list": list(userAdminDataView),
};

export const fateModule = {lists, sources: [userAdminSource], roots} satisfies FateModule;
