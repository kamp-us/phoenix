/**
 * Type-level assertions (no runtime — checked by `tsgo`, not vitest) for the #2715
 * branding slice (epic #2700):
 *
 *   1. `PublishDecision` is nominally branded via effect-smol's `Brand` vocabulary —
 *      a bare `{broadcast}` struct is NOT assignable to it, so the value is
 *      unconstructible outside `sandbox.ts` (only {@link decidePublish} /
 *      {@link alwaysLive} mint one). This is the #1280 guarantee, now carried by
 *      `Brand.Branded` instead of a hand-rolled `unique symbol`.
 *   2. The künye actor-id producers (`adminOf` / `moderatorOf` / `voucherOf`) yield
 *      the shared branded {@link UserId}, not a bare `string`.
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

/** The success (A) channel of an effect type. */
type SuccessOf<T> = [T] extends [Effect.Effect<infer A, unknown, unknown>] ? A : never;

// (1) The two exported constructors mint a `PublishDecision`…
expectTypeOf(decidePublish(null)).toEqualTypeOf<PublishDecision>();
expectTypeOf(alwaysLive).toEqualTypeOf<PublishDecision>();

// …but a bare struct with the same shape is NOT — the brand keeps it unconstructible
// outside the module (the #1280 guarantee, now via `Brand.Branded`).
expectTypeOf<{readonly broadcast: boolean}>().not.toMatchTypeOf<PublishDecision>();

// (2) The grant-derived actor ids are the shared branded `UserId`, not bare `string`.
expectTypeOf<SuccessOf<ReturnType<typeof adminOf>>>().toEqualTypeOf<UserId>();
expectTypeOf<SuccessOf<ReturnType<typeof moderatorOf>>>().toEqualTypeOf<UserId>();
expectTypeOf<SuccessOf<ReturnType<typeof voucherOf>>>().toEqualTypeOf<UserId>();
