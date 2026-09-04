/**
 * Keep this module composer-free (#2523): its consumers are the nav and index CTAs, and
 * folding it back into `MecmuaEditorPage` would drag tiptap into the entry chunk, undoing
 * the editor route's lazy split. The server gates publish regardless — this is UI only.
 */
import type {Tier} from "../../worker/features/kunye/standing";
import type {CatalogKey} from "../i18n/keys";

export type MecmuaPublishAffordance = {kind: "publish"} | {kind: "gate"; messageKey: CatalogKey};

export function mecmuaPublishAffordance(
	isSignedIn: boolean,
	tier: Tier | undefined,
): MecmuaPublishAffordance {
	if (tier === "yazar") return {kind: "publish"};
	return {
		kind: "gate",
		messageKey: isSignedIn ? "mecmua.gate.signedIn" : "mecmua.gate.signedOut",
	};
}

/**
 * Derived from `mecmuaPublishAffordance` rather than restating its rule, so the CTA can
 * never dead-end a viewer into a page they would be publish-gated on.
 */
export function shouldShowMecmuaWriteCta(
	flagOn: boolean,
	isSignedIn: boolean,
	tier: Tier | undefined,
): boolean {
	return flagOn && mecmuaPublishAffordance(isSignedIn, tier).kind === "publish";
}
