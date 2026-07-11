/**
 * The mecmua write-gate pure core, DOM-free AND composer-free (#2523). Held apart from
 * `MecmuaEditorPage` — which pulls in `@kampus/composer` (tiptap/ProseMirror) — so the
 * entry-point CTA consumers (`MecmuaIndexPage`, nav) can decide gating without dragging
 * the heavy editor payload into the entry chunk. That leak is exactly what #2523 removes:
 * lazy-splitting the editor route only helps if nothing eagerly imports it, so the gate
 * helpers live in their own composer-free module.
 *
 * Publish is offered ONLY to a yazar; the tier is the trusted account level read off the
 * fate `me` view. Publish is server-gated by `PublishMecmua` regardless — this only
 * governs what the UI offers.
 */
import type {Tier} from "../../worker/features/kunye/standing";

export type MecmuaPublishAffordance = {kind: "publish"} | {kind: "gate"; message: string};

export function mecmuaPublishAffordance(
	isSignedIn: boolean,
	tier: Tier | undefined,
): MecmuaPublishAffordance {
	if (tier === "yazar") return {kind: "publish"};
	return {
		kind: "gate",
		message: isSignedIn
			? "yayımlamak için yazar olman gerekiyor — çaylakların yazıları henüz yayımlanamaz."
			: "yayımlamak için giriş yapıp yazar olman gerekiyor.",
	};
}

/**
 * Should the "yeni yazı" entry-point CTA (nav + index) be shown to this viewer (#2532)?
 * Gate parity with the editor is structural, not restated: the CTA appears exactly when
 * the write flag is live AND {@link mecmuaPublishAffordance} would offer publish (yazar
 * tier), so it never dead-ends a çaylak/visitor/signed-out reader into a page they'd be
 * publish-gated on. `MECMUA_WRITE` off, or any non-yazar/undefined tier, resolves false.
 */
export function shouldShowMecmuaWriteCta(
	flagOn: boolean,
	isSignedIn: boolean,
	tier: Tier | undefined,
): boolean {
	return flagOn && mecmuaPublishAffordance(isSignedIn, tier).kind === "publish";
}
