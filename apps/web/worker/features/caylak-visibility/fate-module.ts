/** caylak-visibility's contribution to the one fate config. See `../fate/module.ts`. */
import {Fate} from "@kampus/fate-effect";
import type {FateModule, FateRootsRecord} from "../fate/module.ts";
import {mutations} from "./mutations.ts";
import {queries} from "./queries.ts";
import {CaylakVisibilityPreferenceView, caylakVisibilityPreferenceDataView} from "./views.ts";

// Delivered inline by the read and the two writes, never fetched by id — a
// `syntheticSource` makes it view-reachable in codegen with zero capabilities
// (`.patterns/fate-effect-sources.md`).
const caylakVisibilityPreferenceSource = Fate.syntheticSource(CaylakVisibilityPreferenceView);

const roots: FateRootsRecord = {
	"caylakVisibility.mine": caylakVisibilityPreferenceDataView,
};

export const fateModule = {
	queries,
	mutations,
	sources: [caylakVisibilityPreferenceSource],
	roots,
} satisfies FateModule;
