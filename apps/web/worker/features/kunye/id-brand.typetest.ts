/**
 * Type-level assertions — no runtime, checked by `tsgo`, not vitest.
 *
 * Falsifiable: revert `PublishDecision` to a plain interface and assertion (1) fails;
 * drop a `UserId.make` wrap and assertion (2) fails.
 */
import type {Effect} from "effect";
import {expectTypeOf} from "vitest";
import type {UserId} from "../../lib/ids.ts";
import type {adminOf} from "./admin.ts";
import type {moderatorOf} from "./moderate.ts";
import {alwaysLive, decidePublish, type PublishDecision} from "./sandbox.ts";
import type {voucherOf} from "./vouch.ts";

type SuccessOf<T> = [T] extends [Effect.Effect<infer A, unknown, unknown>] ? A : never;

// (1) Only these two constructors mint a `PublishDecision`…
expectTypeOf(decidePublish(null)).toEqualTypeOf<PublishDecision>();
expectTypeOf(alwaysLive).toEqualTypeOf<PublishDecision>();

// …and a bare struct of the same shape is NOT assignable, which is what keeps the
// value unconstructible outside `sandbox.ts`.
expectTypeOf<{readonly broadcast: boolean}>().not.toMatchTypeOf<PublishDecision>();

// (2) Grant-derived actor ids must be the shared branded `UserId`, not bare `string`.
expectTypeOf<SuccessOf<ReturnType<typeof adminOf>>>().toEqualTypeOf<UserId>();
expectTypeOf<SuccessOf<ReturnType<typeof moderatorOf>>>().toEqualTypeOf<UserId>();
expectTypeOf<SuccessOf<ReturnType<typeof voucherOf>>>().toEqualTypeOf<UserId>();
