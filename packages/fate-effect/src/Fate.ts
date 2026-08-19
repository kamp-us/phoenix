/**
 * The `Fate` namespace — the whole authoring surface, exactly the exports below.
 *
 * Every member here is ALSO flat-exported from the barrel: the flat names are what
 * tsgo's declaration printer references when a consumer exports a value built from
 * them, and what the WireError enumeration pin discovers over.
 */
export type {Entity} from "./DataView.ts";
export {list, mutation, query} from "./Operation.ts";
export {source, syntheticSource} from "./Source.ts";
export {FateWireCode} from "./WireError.ts";
