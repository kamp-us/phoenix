/** admin-console's contribution to the one fate config. See `../fate/module.ts`. */
import type {FateModule, FateRootsRecord} from "../fate/module.ts";
import {adminProbeDataView} from "./probe-view.ts";
import {queries} from "./queries.ts";

const roots: FateRootsRecord = {
	// The admin-console open-gate probe (#2740, epic #2711) — `requireAdmin`-gated; the
	// `admin.probe` resolver owns the gate.
	"admin.probe": adminProbeDataView,
};

export const fateModule = {queries, roots} satisfies FateModule;
