/**
 * The catalog key type, derived from the `tr` catalog rather than hand-listed — a key exists
 * because a Turkish surface file declares it, and `en` is checked against that set (ADR 0347).
 * A type-only import, so nothing here puts a runtime edge on the catalog.
 */
import type {tr} from "./tr";

export type CatalogKey = keyof typeof tr;
