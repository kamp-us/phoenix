/**
 * Feature-local rather than in the shared `lib/ids.ts` because it is mecmua's OWN
 * entity, not a cross-feature id. The brand is type-only, decoding byte-identically —
 * only the type checker gains the nominal distinction.
 */
import {brandedId} from "../../lib/ids.ts";

export const MecmuaPostId = brandedId("MecmuaPostId");
export type MecmuaPostId = typeof MecmuaPostId.Type;
