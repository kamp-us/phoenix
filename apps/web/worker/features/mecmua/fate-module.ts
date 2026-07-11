/** mecmua's contribution to the one fate config. See `../fate/module.ts`. */
import {Fate} from "@kampus/fate-effect";
import type {FateModule} from "../fate/module.ts";
import {mutations} from "./mutations.ts";
import {MecmuaPostView} from "./views.ts";

// The write path returns `MecmuaPostView` inline, so the entity needs a source to be
// view-reachable in codegen. A `syntheticSource` (no by-id fetch path) is the minimal
// write-lane footprint — the mutation delivers the row in its response, no re-fetch.
// The read path (#2498) replaces this with the real byIds `mecmuaPostSource`.
const mecmuaPostSource = Fate.syntheticSource(MecmuaPostView);

export const fateModule = {
	mutations,
	sources: [mecmuaPostSource],
} satisfies FateModule;
