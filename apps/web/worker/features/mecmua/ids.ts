/**
 * mecmua's feature-local branded id — `MecmuaPostId`, the nominal tag for a
 * `mecmua_post` row's worker-private id (epic #2700). Lives here beside the
 * feature rather than in the shared `lib/ids.ts` because it is mecmua's OWN
 * entity, not a cross-feature id: `mecmua_post` is a distinct brand from pano's
 * `PostId` (a `mecmua_post` id and a `pano_post` id are never interchangeable),
 * and keeping it feature-local keeps sibling id slices from colliding on the
 * shared module. The cross-feature `UserId` (a mecmua author IS a user) is
 * imported read-only from `lib/ids.ts`; mecmua does not re-mint it.
 *
 * The brand is type-only (`brandedId` = effect-smol `SCHEMA.md` §Branding): it
 * decodes byte-identically, so the D1/wire bytes are unchanged — only the type
 * checker gains the nominal distinction that makes an `authorId`/`postId` swap a
 * compile error.
 */
import {brandedId} from "../../lib/ids.ts";

/** A `mecmua_post` row id — mecmua's own entity, distinct from pano's `PostId`. */
export const MecmuaPostId = brandedId("MecmuaPostId");
export type MecmuaPostId = typeof MecmuaPostId.Type;
