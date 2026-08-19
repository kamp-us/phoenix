/** admin-console's contribution to the one fate config. See `../fate/module.ts`. */
import type {FateModule, FateRootsRecord} from "../fate/module.ts";
import {adminProbeDataView} from "./probe-view.ts";
import {queries} from "./queries.ts";

const roots: FateRootsRecord = {
	// The `admin.probe` resolver owns the `requireAdmin` gate (#2740).
	"admin.probe": adminProbeDataView,
};

export const fateModule = {queries, roots} satisfies FateModule;
