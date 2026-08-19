/**
 * A type-level assertion with no runtime, checked by `tsgo` rather than vitest:
 * transposing a `UserId` and a `CandidateId` must be a compile error (#2714), even though
 * both are plain strings at runtime.
 */
import {expectTypeOf} from "vitest";
import type {UserId} from "../../lib/ids.ts";
import type {CandidateId} from "./ids.ts";

expectTypeOf<UserId>().toMatchTypeOf<string>();
expectTypeOf<CandidateId>().toMatchTypeOf<string>();

expectTypeOf<UserId>().not.toEqualTypeOf<CandidateId>();
expectTypeOf<UserId>().not.toMatchTypeOf<CandidateId>();
expectTypeOf<CandidateId>().not.toMatchTypeOf<UserId>();

declare const someUserId: UserId;
declare const someCandidateId: CandidateId;

// The literal "a swap fails pnpm typecheck" proof: were the two interchangeable,
// these `@ts-expect-error` directives would themselves fail as unused (TS2578).
// @ts-expect-error a CandidateId cannot stand in for a UserId — the vouch-flow swap is a compile error
export const _candidateAsUser: UserId = someCandidateId;
// @ts-expect-error a UserId cannot stand in for a CandidateId — the vouch-flow swap is a compile error
export const _userAsCandidate: CandidateId = someUserId;
