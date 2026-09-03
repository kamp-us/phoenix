/**
 * The locale→catalog seam, and the ONE place `en` is reached from. `tr` is a static import so
 * the default locale needs no round trip; `en` is behind `import("./en")` so a Turkish reader
 * ships zero English bytes (ADR 0347). `catalog-split.unit.test.ts` bundles this module and
 * fails if that split stops holding.
 *
 * React-free on purpose: the split proof bundles this graph, and a React edge would make that
 * test bundle the whole renderer.
 */
import type {CatalogKey} from "./keys";
import type {Locale} from "./locale";
import {tr} from "./tr";

export type Catalog = Readonly<Record<CatalogKey, string>>;

export const trCatalog: Catalog = tr;

export async function loadCatalog(locale: Locale): Promise<Catalog> {
	if (locale === "tr") return trCatalog;
	const {en} = await import("./en");
	return en;
}
