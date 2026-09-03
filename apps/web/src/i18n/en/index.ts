import type {CatalogKey} from "../keys";
import {auth} from "./auth";
import {layout} from "./layout";
import {wire} from "./wire";

/**
 * The English catalog. Reached only through `catalog.ts`'s dynamic `import("./en")`, so a
 * Turkish reader downloads none of it.
 *
 * `satisfies` here catches a key the English side is MISSING. The excess direction — a key only
 * `en` declares — is caught in the per-surface file instead (`en/layout.ts`), because TypeScript
 * runs excess-property checks on a plain object literal and not on spread members.
 */
export const en = {
	...auth,
	...layout,
	...wire,
} satisfies Record<CatalogKey, string>;
