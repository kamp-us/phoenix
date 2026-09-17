/**
 * Notify's state, and everything that is a pure function of it.
 *
 * **What is not here is the point of the file.** No URL, no header, no topic, no bearer token —
 * nothing a person would have to rotate if this record leaked. Tuval checkpoints a program's state
 * to disk and hands it to a window, so a field on this interface is a field written down and shown;
 * the target's secrets live in the closure `notify(...)` was called with and have no path here.
 * What state carries about the target is its `kind` — the word `webhook`, `ntfy` or `stdout` — which
 * is what a tile needs to say what this program is and tells a reader nothing they could spend.
 *
 * **Two fields the reducer never writes.** `id` and `kind` are env, not state: the config chose
 * both at `notify(...)` and nothing that happens to a notifier moves either. They are on the record
 * because a tile and a window are handed one thing — this process's public state — and "which
 * notifier is this, and where does it send" is the first line either wants.
 *
 * **It is also the browser half's only source, and it stays kernel-free.** `./window.tsx` runs in a
 * page, where the kernel's `node:crypto` chain cannot load, so the shape of the state, the
 * predicate over it and every line drawn from it live here and the browser has no path to
 * `./notify.ts`. The one import from `@kampus/tuval` is a type — erased under
 * `verbatimModuleSyntax`, so the built `state.js` a browser loads imports nothing of Tuval at all.
 * This is the split `@kampus/tuval-cron` drew between its `state.ts` and its `window.tsx`, for
 * the same reason.
 */

import type { TurnResultSchema } from "@kampus/tuval/ai-agent/ports";
import type { Attempt, Outgoing, TargetKind } from "./target.ts";

/**
 * A turn as it arrives on `message`, on the encoded side — the shape `./notify.ts` declares that
 * port over. Named here, from a **type-only** import, because the window's composer has to build
 * one and must not reach the module that declares the port: `./notify.ts` imports
 * `@kampus/tuval/authoring`, and that reaches the kernel.
 */
export type Turn = typeof TurnResultSchema.Encoded;

/**
 * One delivery, as it was recorded and as it was announced — the same record on both sides, because
 * the `delivered` out-port's payload *is* the history entry and restating it twice is how the two
 * drift. `status` is absent when the request never got an answer at all; `reason` is present only
 * when there was no request — today that is the single word `dropped: outbox full`, which is how a
 * refused arrival tells both a reader and a listener that this message is not coming.
 */
export interface Delivery {
  /**
   * What was sent, verbatim. It is here because a log of ten `ok`s is a page nobody opens twice:
   * the thing a person came to a notifier's window to read is the message, and a record that keeps
   * only the verdict cannot show it. It is the message's text and never the target's — the target
   * is the credential this file exists to keep out, and `text` arrived on a port.
   */
  readonly text: string;
  readonly ok: boolean;
  readonly status?: number;
  readonly reason?: string;
  readonly at: number;
}

/**
 * The outbox, shaped so its invariant is the type rather than a rule somebody has to remember.
 *
 * The message being delivered is `inflight` and nothing else is. It is a *field* and not the zeroth
 * cell of an array because that is exactly what used to go wrong: a bounded array that drops its
 * oldest element drops the message a `Deliver` is in flight for, which leaves the answer to a
 * request that has already left with nothing to be recorded against. With the head out of the array
 * there is no index by which an arrival could reach it, so that cannot be written.
 *
 * `queue` is what waits, oldest first. The two move in one direction only: an arrival fills
 * `inflight` when it is `null` and otherwise goes on the tail of `queue`, and only an answer pulls
 * `queue`'s head into `inflight`. So `inflight === null` implies an empty `queue` by construction,
 * which makes "nothing is in flight" and "there is nothing to send" the same question.
 */
export interface Outbox {
  readonly inflight: Outgoing | null;
  readonly queue: ReadonlyArray<Outgoing>;
}

export interface NotifyState {
  /** What this notifier is called: its program id, its graph node id, and its spell. */
  readonly id: string;
  /** `webhook`, `ntfy` or `stdout` — the target's discriminant and nothing else about it. */
  readonly kind: TargetKind;
  /**
   * Messages taken but not yet delivered. A delivery is asked for by whichever cell put a message
   * in `inflight`, so draining it asks for the next message's and an empty outbox asks for nothing
   * at all. One delivery at a time, in the order the messages arrived.
   */
  readonly outbox: Outbox;
  /** Newest first, bounded at `HISTORY`. */
  readonly deliveries: ReadonlyArray<Delivery>;
  /**
   * How many messages this process has taken. It exists to make an outbox key unique: a delivery
   * is identified by the in-flight message's `key` — on the history, in a log, and in the `Deliver`
   * the handler is invoked with — and two messages with the same text arriving in the same
   * millisecond would otherwise be indistinguishable. A counter is the one thing that cannot
   * collide.
   */
  readonly seq: number;
}

/**
 * How many deliveries the history keeps. Bounded, because an unbounded log in state is a leak with
 * a name — and this record is checkpointed to disk, so an unbounded one is a file that grows for
 * ever. Fifty rather than ten since the record started carrying the message: a window that reads
 * as a conversation wants more than a screenful of scrollback, and fifty short notifications is
 * still a checkpoint measured in kilobytes.
 */
export const HISTORY = 50;

/**
 * How many undelivered messages the outbox holds, the one in flight included. Bounded for the same
 * reason — and a full outbox **refuses the arrival** rather than dropping something it has already
 * taken. The refusal is a record: `ok: false` in the history and the same record on `delivered`, so
 * the one message this notifier could not accept is the loudest thing on the tile rather than the
 * quietest. Dropping the oldest was the other option and it is the wrong one, because the oldest is
 * the message a request may already have been sent for and there is no honest record to write for
 * it.
 */
export const OUTBOX = 16;

/** What a refused arrival says, in the one place the record and everything reading it agree on. */
export const DROPPED = "dropped: outbox full";

/** An outbox with nothing in it — what `init` seeds and what a drained outbox returns to. */
export const EMPTY_OUTBOX: Outbox = { inflight: null, queue: [] };

/** The history with one more delivery at its head, bounded. Every cell that records one agrees here. */
export const recorded = (
  deliveries: ReadonlyArray<Delivery>,
  delivery: Delivery,
): ReadonlyArray<Delivery> => [delivery, ...deliveries].slice(0, HISTORY);

/** How many messages the outbox is holding, the one in flight included. */
export const pending = (outbox: Outbox): number =>
  (outbox.inflight === null ? 0 : 1) + outbox.queue.length;

/** Whether the outbox can take another message at all. `queued` is only meaningful when it can. */
export const full = (outbox: Outbox): boolean => pending(outbox) >= OUTBOX;

/**
 * The outbox with one more message in it: in flight if nothing else is, on the tail of the queue
 * otherwise. Unbounded on purpose — the bound is `full`, asked by the cell that decides whether to
 * take the arrival at all, because a refusal has a record to write and this function has no history
 * to write it in.
 */
export const queued = (outbox: Outbox, out: Outgoing): Outbox =>
  outbox.inflight === null
    ? { inflight: out, queue: outbox.queue }
    : { inflight: outbox.inflight, queue: [...outbox.queue, out] };

/**
 * The outbox after the in-flight message is answered: the queue's head takes its place, or the
 * outbox is empty. The **only** function that removes `inflight`, and it is reachable from the one
 * cell that holds an answer — which is the whole of "an arrival never removes the message in
 * flight", stated once and enforced by the type rather than by an index check.
 */
export const drained = (outbox: Outbox): Outbox => {
  const [next, ...rest] = outbox.queue;
  return next === undefined ? EMPTY_OUTBOX : { inflight: next, queue: rest };
};

/**
 * One delivery record off the message it was for and the attempt that answered it, with `status`
 * absent rather than `undefined` when there is none.
 *
 * The message comes in as an argument rather than being read off `state.outbox.inflight`, and that
 * is the point: an answer carries the message it answers for, so there is no arm here for "the
 * outbox was empty when the answer arrived". `./deliver.ts`'s `DeliveredEvent` carries it because
 * the handler was handed it on the effect.
 */
export const delivery = (
  out: Outgoing,
  attempt: Attempt,
  at: number,
): Delivery => ({
  text: out.text,
  ok: attempt.ok,
  ...(attempt.status === undefined ? {} : { status: attempt.status }),
  at,
});

/**
 * The record a refused arrival leaves behind: a failure carrying a reason and no status, because
 * nothing was sent and so there is no answer to carry. It keeps the text all the same — the one
 * message this notifier could not take is the one a reader most wants to see in the log.
 */
export const dropped = (out: Outgoing, at: number): Delivery => ({
  text: out.text,
  ok: false,
  reason: DROPPED,
  at,
});

export const hhmm = (at: number): string =>
  new Date(at).toTimeString().slice(0, 5);

/**
 * The status line, in one place, so the tile and anything else reading this program draw the same
 * sentence: `idle` before anything has happened, `sending` while a message is in flight, and
 * `delivered 07:00 · ok` — or `· failed 500`, or `· dropped: outbox full` — once one has landed,
 * not landed, or was never taken.
 */
export const statusLine = (state: NotifyState): string => {
  if (state.outbox.inflight !== null) return "sending";
  const last = state.deliveries[0];
  if (last === undefined) return "idle";
  const verdict = last.ok
    ? "ok"
    : (last.reason ??
      (last.status === undefined ? "failed" : `failed ${last.status}`));
  return `delivered ${hhmm(last.at)} · ${verdict}`;
};

/**
 * The tile's first line, and the window's heading — one sentence, one place. Both are read off the
 * state a process publishes rather than off the closure `notify(...)` was called with, so a window
 * opened on a restored process says what that process says.
 */
export const titleLine = (state: NotifyState): string =>
  `${state.id} · ${state.kind}`;

/**
 * The first line of a message, with an ellipsis when there was more of it. A notification is often
 * a whole brief; a log row is one line. The rest is not lost — it is on the target, which is where
 * the message was actually going.
 */
export const firstLine = (text: string): string => {
  const [head = "", ...rest] = text.split("\n");
  const more = rest.join("\n").trim() !== "";
  return more ? `${head.trim()} …` : head.trim();
};

/**
 * How one delivery ended, as the log writes it: `ok`, `ok · 204`, `failed · 500`, `failed ·
 * dropped: outbox full`, or a bare `failed · no answer` when the request never got one. The same
 * three facts `statusLine` reads, said in the shape a row wants rather than the shape a tile wants
 * — which is why it is a function beside that one and not a second reading of the record.
 */
export const outcome = (record: Delivery): string => {
  if (record.ok) {
    return record.status === undefined ? "ok" : `ok · ${record.status}`;
  }
  const why =
    record.reason ??
    (record.status === undefined ? "no answer" : String(record.status));
  return `failed · ${why}`;
};

// -- The window's view of all that ------------------------------------------

/** One delivery as the window lists it: the clock, what went out, and how it ended. */
export interface DeliveryView {
  /** Stable within one view: the clock plus the row's place, since two deliveries share a minute. */
  readonly key: string;
  readonly at: string;
  /** The first line of the message, with an ellipsis when there was more. */
  readonly text: string;
  readonly ok: boolean;
  /** `ok · 204`, `failed · 500`, `failed · dropped: outbox full`. */
  readonly outcome: string;
}

/** The message on the wire right now, and how many are lined up behind it. */
export interface SendingView {
  readonly text: string;
  /** Waiting in the outbox behind this one. Zero means this is the last of them. */
  readonly waiting: number;
}

/**
 * Everything the window draws, as data. Pure, so the mapping is a unit test rather than a render
 * test: what a window shows is decided here and React only puts it on the screen.
 */
export interface NotifyWindowView {
  /** The heading: `notify · ntfy` — the tile's own first line. */
  readonly heading: string;
  /** `idle`, `sending`, `delivered 07:00 · ok` — the tile's own second line. */
  readonly status: string;
  /** The spell the composer stands in for, so the window can name it. */
  readonly spell: string;
  /**
   * Oldest first, at most `HISTORY`. A chat reads downwards: the newest message is the one at the
   * bottom, nearest the composer, which is where a reader's eye already is.
   */
  readonly log: ReadonlyArray<DeliveryView>;
  /** The message still on the wire, drawn under the log, or `null` when nothing is in flight. */
  readonly sending: SendingView | null;
  /** What to say where the log would be, when there is none. */
  readonly empty: string;
}

/** The whole of the window's reading of a notifier. */
export const notifyView = (state: NotifyState): NotifyWindowView => {
  const kept = state.deliveries.slice(0, HISTORY);
  const inflight = state.outbox.inflight;
  return {
    heading: titleLine(state),
    status: statusLine(state),
    spell: `:${state.id} send <text>`,
    // `deliveries` is newest-first, because that is what a tile reads and what the bound drops
    // from. A chat is the other way round, so the reversal happens here — once, in the view —
    // rather than in the record, where it would cost the history its cheap head.
    log: kept
      .map((record, index) => ({
        key: `${record.at}-${kept.length - 1 - index}`,
        at: hhmm(record.at),
        text: firstLine(record.text),
        ok: record.ok,
        outcome: outcome(record),
      }))
      .reverse(),
    sending:
      inflight === null
        ? null
        : {
            text: firstLine(inflight.text),
            waiting: state.outbox.queue.length,
          },
    empty:
      inflight === null
        ? "Nothing sent yet."
        : "Nothing sent yet — the first message is still going.",
  };
};

/**
 * The predicate a renderer table admits this program's state through (ADR 0358). It is exported as
 * `admits` from `./window.tsx`, which is the export the page's module loader reads.
 *
 * It checks the fields the window draws and their types, and nothing beyond them: a kernel one
 * commit older than the window sends deliveries with no `text`, and the honest answer to that is
 * the window's own refusal placeholder rather than a throw inside React.
 */
export const isNotifyState = (state: unknown): state is NotifyState => {
  if (typeof state !== "object" || state === null) return false;
  const candidate = state as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.kind === "string" &&
    typeof candidate.seq === "number" &&
    isOutbox(candidate.outbox) &&
    Array.isArray(candidate.deliveries) &&
    candidate.deliveries.every(isDelivery)
  );
};

const isOutgoing = (out: unknown): out is Outgoing => {
  if (typeof out !== "object" || out === null) return false;
  const candidate = out as Record<string, unknown>;
  return (
    typeof candidate.key === "string" &&
    typeof candidate.text === "string" &&
    (candidate.title === undefined || typeof candidate.title === "string")
  );
};

const isOutbox = (outbox: unknown): outbox is Outbox => {
  if (typeof outbox !== "object" || outbox === null) return false;
  const candidate = outbox as Record<string, unknown>;
  return (
    (candidate.inflight === null || isOutgoing(candidate.inflight)) &&
    Array.isArray(candidate.queue) &&
    candidate.queue.every(isOutgoing)
  );
};

export const isDelivery = (record: unknown): record is Delivery => {
  if (typeof record !== "object" || record === null) return false;
  const candidate = record as Record<string, unknown>;
  return (
    typeof candidate.text === "string" &&
    typeof candidate.ok === "boolean" &&
    typeof candidate.at === "number" &&
    (candidate.status === undefined || typeof candidate.status === "number") &&
    (candidate.reason === undefined || typeof candidate.reason === "string")
  );
};

/**
 * The history, minus anything this version cannot read. Today that is one shape: a record written
 * before deliveries carried their `text`, which has a verdict and a clock and no message.
 *
 * **It runs in `restored` and nowhere else, which is the honest place for a migration.** The
 * alternative was a window that tolerates a text-less row, and that is worse twice over: it puts
 * the old shape in the type for ever, and it makes `admits` — the predicate the page mounts this
 * renderer through — answer `false` for a whole checkpoint because of three rows written yesterday,
 * so the window refuses to draw *anything* for the fifty deliveries after them. A restore reads the
 * checkpoint once; dropping there costs the unreadable rows and nothing else.
 *
 * What it costs a reader is those rows and their verdicts. The tile carries no count, so nothing
 * there is wrong afterwards — but the status line reads the *newest* record, so a desk whose newest
 * deliveries were all pre-`text` comes back reading `idle` rather than the verdict it showed before
 * the restart. That is the truthful line about a history this version cannot read.
 */
export const readable = (
  deliveries: ReadonlyArray<Delivery>,
): ReadonlyArray<Delivery> => deliveries.filter(isDelivery);

/**
 * One line of text as the `message` port takes it: a turn nobody's agent ran, announced as ok.
 *
 * It lives here rather than beside the spell because **both** callers need it and only one of them
 * may see the kernel — `./notify.ts`'s `send` command wraps its argument with this, and
 * `./window.tsx`'s composer wraps its input with the same function. One wrapper, so the manual
 * path, the window and a routed brief are three arrivals of one payload shape in one cell.
 */
export const asTurn = (text: string): Turn => ({ text, items: [], ok: true });

/**
 * The event the window's composer sends: the same arrival `:<id> send <text>` puts on the `message`
 * in-port, because a window and a spell asking for the same thing must reach the same cell. The
 * spell is a bare `send("message", asTurn(text))`, so this is that send without the palette.
 */
// A `type` and not an `interface`, deliberately: only an alias gets TypeScript's implicit index
// signature, and without one this shape is not assignable to Tuval's `Message` — which is what
// `WindowHost.dispatch` is typed at.
export type NotifySendEvent = {
  readonly type: "message";
  readonly payload: Turn;
};

/** That event, built. A function rather than a constant so no caller can hold a shared object. */
export const sendEvent = (text: string): NotifySendEvent => ({
  type: "message",
  payload: asTurn(text),
});
