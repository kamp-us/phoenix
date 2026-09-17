/**
 * The effect this program answers when it wants a message delivered, and the handler that performs
 * it.
 *
 * **Subs observe, handlers perform** ([#8716](https://github.com/kamp-us/phoenix/issues/8716)
 * R12.1). Delivery used to happen inside a dep-keyed Sub keyed on the outbox's in-flight message,
 * which was the wrong half of that sentence: a Sub is long-lived work that *watches* something and
 * pushes what it sees, and a webhook POST watches nothing. It is one unit of work a cell asked for,
 * which is an effect — and as of
 * [#9295](https://github.com/kamp-us/phoenix/pull/9295) an authored program may name an effect of
 * its own. So `Deliver` is this package's, `update` answers it, and the handler below runs it.
 *
 * **The effect carries the message and not the target.** `notify.ts`'s header says why at length:
 * a webhook URL is a credential, not a coordinate, and the one rule this package holds above the
 * others is that no secret is ever written down. State is checkpointed; an effect is dispatched,
 * named in a `HandlerFailed` and read by anything watching the loop. Neither is a place for a
 * credential, so the target stays where it has always been — in the closure `notify(...)` was
 * called with, reached by the live `Transport` layer and by nothing else.
 *
 * **The transport is a service, so the handler is testable without a socket.** `Transport` answers
 * one question — send this message, tell me what happened — and it has two layers: `liveTransport`,
 * which closes over the config's target and its `fetch`/`write`, and `fakeTransport`, which records
 * what it was asked to send and answers a stated `Attempt`. A test then runs the *real* handler.
 */

import { Context, Effect, Layer } from "effect";
import {
  type Attempt,
  attemptDelivery,
  type Fetch,
  type NotifyTarget,
  type Outgoing,
  type Write,
} from "./target.ts";

/**
 * The key the actor dispatches on. A row's `handlers` record is keyed by the effect's own `type`
 * string (`HostHandlers<M, C, E, R>` is `{[K in C["type"]]: …}`), so this constant is the one place
 * the effect and its handler have to agree — and they agree by construction rather than by two
 * string literals that happen to match.
 */
export const DELIVER = "deliver";

/**
 * Send this message. Plain tagged data, the way every kernel effect is: a record a cell can build,
 * a test can compare with `toEqual`, and a checkpoint would carry nothing dangerous in.
 */
export interface Deliver {
  readonly type: typeof DELIVER;
  readonly out: Outgoing;
}

/** The effect, as an `update` cell answers it: `[state, [deliver(out)]]`. */
export const deliver = (out: Outgoing): Deliver => ({ type: DELIVER, out });

/**
 * What the handler dispatches back into the program when an attempt comes back — the same event
 * the delivering Sub used to dispatch, so the `delivered` cell is untouched by this refactor.
 */
export interface DeliveredEvent {
  readonly type: "delivered";
  /**
   * The message this is the answer to. It rides on the event rather than being read back off
   * `state.outbox.inflight` in the cell, and that is what makes the history's `text` honest: an
   * answer carries what it answers for, so there is no arm for "the outbox was empty when it came
   * back" and no way for a record to be written against the wrong message.
   */
  readonly out: Outgoing;
  readonly attempt: Attempt;
  readonly at: number;
}

export const deliveredEvent = (
  out: Outgoing,
  attempt: Attempt,
  at: number,
): DeliveredEvent => ({
  type: "delivered",
  out,
  attempt,
  at,
});

/**
 * The one thing a delivery needs from the world. Narrow on purpose: `send` takes the message and
 * answers what happened, and the target is already inside whichever layer answered this tag — so a
 * handler holds no URL, a fake holds no network, and neither can drift from the other.
 */
export class Transport extends Context.Service<
  Transport,
  { readonly send: (out: Outgoing) => Effect.Effect<Attempt> }
>()("@kampus/tuval-notify/Transport") {}

/**
 * The real one: the config's target, the config's `fetch` and `write`, and `target.ts`'s
 * `attemptDelivery` — which never throws, so this never fails. `Effect.promise` and not
 * `tryPromise` for exactly that reason: a refused DNS lookup is already an `ok: false` by the time
 * it reaches here, and a second error channel would only invite somebody to log the cause.
 */
export const liveTransport = (
  target: NotifyTarget,
  io: { readonly fetch: Fetch; readonly write: Write },
): Layer.Layer<Transport> =>
  Layer.succeed(Transport, {
    send: (out: Outgoing) =>
      Effect.promise(() => attemptDelivery(target, out, io)),
  });

/** A fake transport: what it was asked to send, and the answer it was told to give. */
export interface FakeTransport {
  /** Every message the program asked to have delivered, in order. */
  readonly sent: ReadonlyArray<Outgoing>;
  readonly layer: Layer.Layer<Transport>;
}

/**
 * A transport with no socket behind it. The handler that runs on it is the shipped handler — the
 * only thing swapped out is the sending — so a test that drives a delivery through this is
 * asserting about the code a desk runs.
 */
export const fakeTransport = (
  answer: Attempt | ((out: Outgoing) => Attempt) = { ok: true, status: 200 },
): FakeTransport => {
  const sent: Outgoing[] = [];
  return {
    sent,
    layer: Layer.succeed(Transport, {
      send: (out: Outgoing) => {
        sent.push(out);
        return Effect.succeed(
          typeof answer === "function" ? answer(out) : answer,
        );
      },
    }),
  };
};

/**
 * The handler, over a transport and a clock. It is a `HostHandlers` handler, so it answers its
 * follow-up events as a **list** — one `delivered` here, never a bare event — and the actor
 * dispatches each of them back into this process's own inbox, where the `delivered` cell drains the
 * outbox and records the outcome.
 *
 * The layer is provided here rather than left on the requirements, because the kernel seals a
 * handler's context down to its own services before running it: a requirement this package invented
 * has nowhere to be satisfied from up there, so it is satisfied down here.
 */
export const deliverHandler =
  (transport: Layer.Layer<Transport>, now: () => number) =>
  (cmd: Deliver): Effect.Effect<ReadonlyArray<DeliveredEvent>> =>
    Effect.gen(function* () {
      const sender = yield* Transport;
      const attempt = yield* sender.send(cmd.out);
      return [deliveredEvent(cmd.out, attempt, now())];
    }).pipe(Effect.provide(transport));
