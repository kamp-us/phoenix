/**
 * The merged feature flags as a kernel service, so the node side can read what a config layer
 * stated.
 *
 * `./features.ts` holds the vocabulary both ends share and stays node-free, because the browser
 * imports the generated `virtual:tuval/features` written from it (#8439). This module is the other
 * end: the flags a boot actually resolved, carried into the kernel context `start` builds. A
 * program row's layer declares `Features` as its leftover requirement and is handed it at spawn —
 * the seam a Claude row already reaches `SpellBridge` through (#7951) — because a config module is
 * evaluated before the merge exists, so a row's layer is a closure that cannot read one (#8595).
 */

import {Context, Layer} from "effect";
import {featuresDefault, type TuvalFeatures} from "./features.ts";

export class Features extends Context.Service<Features, TuvalFeatures>()("tuval/Features") {
	/** The record a boot merged. `start` builds this; a caller with no config gets the defaults. */
	static readonly layer = (features: TuvalFeatures = featuresDefault): Layer.Layer<Features> =>
		Layer.succeed(Features, features);
}
