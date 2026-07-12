/**
 * Type-level assertion (no runtime — checked by `tsgo`, not vitest): the pasaport
 * vouch-flow ids `UserId` and `CandidateId` are nominally distinct, so transposing
 * the acting user's id and the vouch candidate's id is a compile error (#2714 AC#2),
 * while both stay plain strings at runtime. Mirrors `../kunye/admin.typetest.ts`.
 */
import {expectTypeOf} from "vitest";
import type {UserId} from "../../lib/ids.ts";
import type {CandidateId} from "./ids.ts";

// Both brands erase to `string` at runtime — the brand is type-only (#2735).
expectTypeOf<UserId>().toMatchTypeOf<string>();
expectTypeOf<CandidateId>().toMatchTypeOf<string>();

// The distinctness that makes a userId/candidateId swap unrepresentable: neither
// brand is assignable to the other, so the vouch pairing can't be transposed.
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
