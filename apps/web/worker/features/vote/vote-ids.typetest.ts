/**
 * Type-level assertion (no runtime — checked by `tsgo`, not vitest): `UserId` (the
 * voter) and `TargetId` (the vote/reaction target) are nominally distinct, so
 * transposing them is a compile error (#2723 AC#3) while both stay plain strings at
 * runtime. Mirrors `../pasaport/pasaport-ids.typetest.ts`.
 */
import {expectTypeOf} from "vitest";
import type {TargetId, UserId} from "../../lib/ids.ts";

// Both brands erase to `string` at runtime — the brand is type-only (#2735).
expectTypeOf<UserId>().toMatchTypeOf<string>();
expectTypeOf<TargetId>().toMatchTypeOf<string>();

// Neither brand is assignable to the other, so the two roles cannot be transposed.
expectTypeOf<UserId>().not.toEqualTypeOf<TargetId>();
expectTypeOf<UserId>().not.toMatchTypeOf<TargetId>();
expectTypeOf<TargetId>().not.toMatchTypeOf<UserId>();

declare const someUserId: UserId;
declare const someTargetId: TargetId;

// The literal "a voterId/targetId swap fails pnpm typecheck" proof: were the two
// interchangeable, these `@ts-expect-error` directives would themselves fail as
// unused (TS2578).
// @ts-expect-error a TargetId cannot stand in for a UserId — the voter/target swap is a compile error
export const _targetAsVoter: UserId = someTargetId;
// @ts-expect-error a UserId cannot stand in for a TargetId — the voter/target swap is a compile error
export const _voterAsTarget: TargetId = someUserId;
