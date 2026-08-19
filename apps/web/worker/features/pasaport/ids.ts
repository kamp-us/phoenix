/**
 * Pasaport feature-local branded ids (epic #2700), minted here rather than on the shared
 * `lib/ids.ts` so sibling slices don't append-conflict. See `../../lib/ids.ts` for the
 * branding idiom.
 */
import {brandedId} from "../../lib/ids.ts";

/**
 * A user id in the vouch candidate role. Branded distinctly from `UserId` so the acting
 * user's id and the candidate's id can't be transposed without a compile error.
 */
export const CandidateId = brandedId("CandidateId");
export type CandidateId = typeof CandidateId.Type;
