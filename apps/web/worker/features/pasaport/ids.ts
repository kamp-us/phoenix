/**
 * Pasaport feature-local branded ids (epic #2700). The cross-feature `UserId` is
 * imported read-only from the shared `lib/ids.ts` (the #2735 tracer module); only
 * the pasaport-owned `CandidateId` is minted here, feature-locally, so sibling
 * slices don't append-conflict on the shared module.
 *
 * `CandidateId` is a user account id in the vouch (kefil) *candidate* role — the
 * çaylak being vouched. It is a plain string at runtime, but branding it distinctly
 * from `UserId` makes the vouch-flow pairing type-distinct: the acting user's id and
 * the candidate's id can no longer be transposed without a compile error, even though
 * both are user ids. See `../../lib/ids.ts` for the branding idiom (effect-smol
 * `SCHEMA.md` §Branding) — not re-derived here.
 */
import {brandedId} from "../../lib/ids.ts";

/** A vouch candidate's account id — a user id in the candidate (vouched çaylak) role. */
export const CandidateId = brandedId("CandidateId");
export type CandidateId = typeof CandidateId.Type;
