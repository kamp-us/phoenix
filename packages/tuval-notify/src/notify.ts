/**
 * `notify` — a program that takes a message on a port and delivers it off the desk. That is the
 * whole of v1: it takes text, it sends text somewhere a person will see it, and it says on its
 * board tile whether that landed.
 *
 * **This file lives outside Tuval.** Every name it imports comes through a published door
 * (#8943, #9250) — `@kampus/tuval/authoring` and `@kampus/tuval/ai-agent/ports` — the same rule
 * `@kampus/tuval-cron` holds itself to. Nothing reaches into `@kampus/tuval/src/...`.
 *
 * **No secret is ever checkpointed, and no secret is ever logged.** A webhook URL is not a
 * coordinate, it is a credential: anyone holding `https://discord.com/api/webhooks/…/…` can post as
 * you, and the same is true of an `Authorization` header and of an ntfy topic name. So the target
 * is captured in *this function's closure* and never put on state — `./state.ts` carries the word
 * `webhook`, `ntfy` or `stdout` and not one character more — and it is never put on an **effect**
 * either: `Deliver` carries the message and the live `Transport` layer carries the target. Tuval
 * writes a program's state to a checkpoint on disk and hands it to a window; a field here is a
 * field written down and shown to whoever opens the desk. Nothing in this package prints a URL
 * either, including on the failure path: a fetch that throws carries the URL in its own message, so
 * `./target.ts` swallows the cause and answers `ok: false` with no status rather than re-throwing
 * something a log would catch.
 *
 * **Delivery happens in an effect handler, because performing work is what a handler is for.**
 * Subs observe; handlers perform (#8716 R12.1). The six kernel effects — spawn, send, ask, stop,
 * emit, reply — do not include an HTTP request, so this program names one of its own: `./deliver.ts`
 * declares `Deliver`, every `update` cell that moves a message into the outbox's in-flight slot
 * answers `deliver(...)` for it, and the handler spread onto the compiled row performs it and
 * dispatches `delivered` back (#9295). One delivery at a time, in arrival order, and no queue of
 * Promises anywhere — the queue is the state, which is the only place a restart can see it.
 *
 * This is what it replaced: a dep-keyed Sub keyed on the in-flight message's `key`. That worked,
 * and it was the wrong shape — a Sub watches something and pushes what it sees, and a webhook POST
 * watches nothing. The invariants did not move an inch; only the thing that performs did.
 *
 * **Delivery is therefore at-least-once across a restart.** A message that was in flight when the
 * desk went down is still on the checkpoint when it comes back, and the `restored` cell answers
 * `deliver` for it again. A duplicate notification is the right failure here: the alternative is
 * dropping the message the desk was told to send, and a notifier that silently loses one is worse
 * than useless.
 *
 * **And nothing is ever lost quietly.** The outbox is bounded, so there is a message this program
 * cannot take; the answer is to refuse *the arrival*, never to evict something already accepted,
 * and to write that refusal down as a failed delivery with a reason. `./state.ts`'s `Outbox` makes
 * the first half structural — the message in flight is a field and not an array cell, so an
 * arrival has no index by which to reach it — and the `message` cell makes the second half a
 * record on the history and on the `delivered` port.
 */

import {TurnResultSchema} from "@kampus/tuval/ai-agent/ports";
import {
	type Answer,
	type AnyProgram,
	type ArrivalEvent,
	type AuthoredEvent,
	defineProgram,
	emit,
	port,
	send,
} from "@kampus/tuval/authoring";
import {type Layer, Schema} from "effect";
import {
	DELIVER,
	type Deliver,
	type DeliveredEvent,
	deliver,
	deliverHandler,
	liveTransport,
	type Transport,
} from "./deliver.ts";
import {NOTIFY_WINDOW_REF} from "./renderer-ref.ts";
import {
	asTurn,
	delivery,
	drained,
	dropped,
	EMPTY_OUTBOX,
	full,
	type NotifyState,
	type Outbox,
	queued,
	readable,
	recorded,
	statusLine,
	titleLine,
} from "./state.ts";
import type {Fetch, NotifyTarget, Outgoing, Write} from "./target.ts";

/**
 * What may arrive on `message`, and it is `TurnResultSchema` itself — the shipped schema out of
 * `@kampus/tuval/ai-agent/ports`, the same object `@kampus/tuval-cron` declares its `brief`
 * out-port over. Not a schema of this package's invention that a turn happens to satisfy: the
 * identical one.
 *
 * **That identity is the whole point.** A route between two ports fits only when the two ends
 * declare the *same* schema — exact equality, not structural compatibility (kamp-us/phoenix #8923,
 * answered by PR #9292, in review). A `Schema.Struct({text})` would admit a `TurnResult` at decode
 * and still be refused at compile, which is the worst of both: it looks composed and does not
 * compose. Declaring the shipped schema is what makes `cron.brief → notify.message` a line a config
 * can write the day #9292 lands.
 *
 * A notification's title is therefore the target's (`notify({target: {…, title: "Morning brief"}})`)
 * — a `TurnResult` carries text, transcript items and an `ok`, and no title.
 */
export const MessageSchema = TurnResultSchema;

/**
 * A turn as it arrives on the wire. `Encoded` rather than `Type` because a port's schema is a
 * `Codec<T, T>` — the same shape both ways, so a payload can be checked with a plain predicate —
 * and it is the encoded side that satisfies that: `TurnResult`'s `items` carry branded ids, which
 * exist only after a decode. A `TurnResult` is assignable here; the reverse needs the decode.
 */
export type Message = typeof TurnResultSchema.Encoded;

/** What the `delivered` out-port announces, and — the same record — what the history keeps. */
export const DeliveredSchema = Schema.Struct({
	/** What went out. The record is the history entry, and a history with no text is a log of verdicts. */
	text: Schema.String,
	ok: Schema.Boolean,
	status: Schema.optionalKey(Schema.Number),
	reason: Schema.optionalKey(Schema.String),
	at: Schema.Number,
});

/**
 * What `:<id> send <text>` takes on the command line: the text, and nothing around it.
 *
 * A struct, because the desk reads a spell's positional parameters off the struct's properties
 * (`commands/parse/spell-index.ts` `readParams`): a bare `Schema.String` has no properties, reads
 * as a spell with no parameters, and every argument to it is refused with "no further arguments".
 * The one property is a rest parameter (the desk's `x-command-rest` annotation), so the text needs
 * no quotes: `:phone send the desk is up` binds the whole tail.
 */
export const SendRequest = Schema.Struct({
	text: Schema.String.annotate({"x-command-rest": true}),
});

/** The id a notifier takes when a config does not name one. */
export const DEFAULT_ID = "notify";

/**
 * The id, checked — the same refusal `@kampus/tuval-cron` makes and for the same three reasons:
 * an id is the program id, the graph node id, and the first token of a spell, and `:my notify send`
 * addresses nothing. Refused at `notify(...)`, where the config is being written.
 */
const checkedId = (id: string | undefined): string => {
	if (id === undefined) return DEFAULT_ID;
	if (id.trim() === "" || /\s/.test(id)) {
		throw new Error(
			`notify: \`id\` must be a non-empty word with no spaces — it is the program id, the graph node id and the spell (\`:${id} send\`): ${JSON.stringify(id)}`,
		);
	}
	return id;
};

export interface NotifyOptions {
	/**
	 * What this notifier is called: its program id, its graph node id, and its spell
	 * (`:phone send …`). Defaults to `"notify"` — name it when a config holds more than one.
	 */
	readonly id?: string;
	/** Where the message goes. A discriminated union, so a half-filled target is a type error. */
	readonly target: NotifyTarget;
	/** The clock, so a test can state the time instead of reading one. */
	readonly now?: () => number;
	/**
	 * The `fetch` a delivery calls. Injected rather than read off the global so a test can assert the
	 * URL, the method, the headers and the body without a network and without patching the global out
	 * from under the rest of the suite. Defaults to `globalThis.fetch`, which is what a desk uses.
	 */
	readonly fetch?: Fetch;
	/** Where a `stdout` target writes. Defaults to `console.log`; a test hands its own. */
	readonly write?: Write;
}

/**
 * The message, normalized: a turn arrives, and the outbox holds what a target can actually send.
 * `items` and `ok` are the transcript's business and cron's; a notification is the text.
 */
const outgoing = (payload: Message, key: string): Outgoing => ({
	key,
	text: payload.text,
});

/**
 * The effects that arm a delivery, and the one rule about them: **a message is delivered by the
 * cell that put it in flight.** Exactly one `Deliver` per message, because the slot is taken by
 * exactly one message at a time and this compares the slot before against the slot after — an
 * arrival that only joined the queue moves nothing here, and an arrival refused by a full outbox
 * least of all.
 *
 * It is the whole of what used to be the Sub's dep key. The Sub re-armed when the key moved; this
 * answers an effect when the *message* moved, which is the same fact stated where the state change
 * happens rather than inferred from it afterwards.
 */
const arming = (before: Outbox, after: Outbox): ReadonlyArray<Deliver> =>
	after.inflight === null || after.inflight === before.inflight ? [] : [deliver(after.inflight)];

/**
 * The authored record, over one set of options. A function rather than a constant because the
 * target and the clock are the config's to state, and the cells close over both.
 */
export const notifyProgram = (options: NotifyOptions) => {
	const id = checkedId(options.id);
	const kind = options.target.kind;
	const now = options.now ?? Date.now;
	return {
		id,
		ports: {
			/** Tell me something to deliver: an AI-agent `TurnResult` — see `MessageSchema`. */
			message: port.in(MessageSchema),
			/**
			 * I delivered something, or failed to. Announced so another program can react to a delivery
			 * — and so that a notifier's outcome is a fact on the wire rather than only a line on a tile.
			 */
			delivered: port.out(DeliveredSchema),
		},
		/**
		 * `id` and `kind` are env rather than state — the config chose both and no cell moves either —
		 * and they are seeded here because a tile is drawn from this record alone. `seq` is what makes
		 * two messages with the same text two different messages: a delivery is identified by that
		 * `key` on the history and in a log, and a key that repeated would make two deliveries
		 * indistinguishable.
		 */
		init: (): NotifyState => ({
			id,
			kind,
			outbox: EMPTY_OUTBOX,
			deliveries: [],
			seq: 0,
		}),
		update: {
			/**
			 * Something to deliver arrived. It goes into the outbox: if nothing was in flight this
			 * message now is, and the cell answers `deliver` for it; if something was, this one waits its
			 * turn and the cell answers nothing — which is the whole of the concurrency story, and it is
			 * in the state rather than in a Promise so a restart can see it.
			 *
			 * **Unless the outbox is full, and then the arrival is refused — loudly.** A notifier that
			 * quietly forgot a message would be worse than one that says it cannot take it, so a refusal
			 * is written down exactly like a failed delivery: `{ok: false, reason: "dropped: outbox
			 * full"}` at the head of the history, the same record announced on `delivered` so a listener
			 * hears it, and the sentence on the tile. What is *not* touched is the message in flight —
			 * `drained` is the only thing that removes it and only a `delivered` answer reaches it.
			 */
			message: (
				state: NotifyState,
				event: ArrivalEvent<"message", Message>,
			): Answer<NotifyState, Deliver> => {
				// The outgoing message is built before the bound is asked, because the refusal has to
				// write it down too: the one notification this program could not take is the one a reader
				// most wants to read. `seq` only moves on the path that takes the message, so a refused
				// arrival consumes no key.
				const seq = state.seq + 1;
				const out = outgoing(event.payload, `${id}-${seq}`);
				if (full(state.outbox)) {
					const record = dropped(out, now());
					return [
						{...state, deliveries: recorded(state.deliveries, record)},
						[emit("delivered", record)],
					];
				}
				const outbox = queued(state.outbox, out);
				return [{...state, seq, outbox}, arming(state.outbox, outbox)];
			},
			/**
			 * An attempt came back. The in-flight message is drained — which puts the next message in
			 * flight, and the cell answers `deliver` for that one, or leaves the outbox empty — the
			 * outcome goes at the head of the history, and the very same record is announced on
			 * `delivered`. One record, recorded and emitted, so the wire and the tile can never disagree
			 * about what happened. This is the only cell that drains.
			 */
			delivered: (state: NotifyState, event: DeliveredEvent): Answer<NotifyState, Deliver> => {
				const record = delivery(event.out, event.attempt, event.at);
				const outbox = drained(state.outbox);
				return [
					{
						...state,
						outbox,
						deliveries: recorded(state.deliveries, record),
					},
					[emit("delivered", record), ...arming(state.outbox, outbox)],
				];
			},
			/**
			 * Back from a checkpoint. `id` and `kind` are re-seeded off the config, which is the
			 * authority on both — a checkpoint written before a config moved from ntfy to a webhook would
			 * otherwise carry the old word on the tile for ever.
			 *
			 * The history is passed through `readable`, which is where the one migration this package has
			 * lives: a delivery written before the record carried its `text` is dropped. It is dropped
			 * here rather than tolerated in the window because `admits` is all-or-nothing — three
			 * text-less rows at the head of a checkpoint would make the window refuse to draw the fifty
			 * good ones behind them. `./state.ts`'s `readable` says what that costs.
			 *
			 * The outbox is left exactly as it was found, deliberately, and the message in it is
			 * delivered again: a restored process starts on its loaded state with no effects at all, so
			 * this cell is the only thing that can put the interrupted message back on the wire.
			 * At-least-once, and the header says why that is the right side to fail on.
			 *
			 * **It asks again every time it is asked, and that is a dependency on being resumed once.**
			 * Two `restored` events on one process are two `Deliver`s for the same message, so the kernel
			 * sending `resume` exactly once per restore is what makes "one restart, one duplicate at
			 * worst" true. The obvious guard — a `delivering` flag on state — is not the fix and would be
			 * a regression: state is what gets checkpointed, so the flag comes back `true` on a desk that
			 * died mid-request and suppresses the one re-delivery this whole cell exists to make. A
			 * duplicate is the failure this program chose; a silent drop is the one it refuses. The case
			 * below `notify.unit.test.ts`'s "restarted" describe pins the behaviour rather than leaving
			 * it latent.
			 */
			restored: (state: NotifyState, _event: AuthoredEvent): Answer<NotifyState, Deliver> => [
				{...state, id, kind, deliveries: readable(state.deliveries)},
				arming(EMPTY_OUTBOX, state.outbox),
			],
		},
		/**
		 * The one door a restarted notifier has back into the world: a restored process starts on its
		 * loaded state with no Cmds, so without this the two env fields are never reconciled and the
		 * message that was in flight never leaves again.
		 */
		resume: (_state: NotifyState) => [{type: "restored" as const}],
		commands: {
			/**
			 * `:<id> send <text>` — deliver one message, now. A bare `send` into this program's own
			 * `message` port and nothing else, which is the whole of what a command may ask for
			 * ([ADR 0372](https://github.com/kamp-us/phoenix/blob/main/.decisions/0372-a-tuval-command-may-only-send.md)
			 * as #8898 amended it). The call resolves to the notifier's own live process, the text lands
			 * on the port above, and the cell that owns it decides — so the manual path and a routed one
			 * are the same arrival in the same cell.
			 *
			 * It is also, today, the only path from a cron's morning brief to a phone — not for want of
			 * a payload to carry (cron emits the brief on `brief`, over this port's own schema) but
			 * because no route between two authored programs compiles yet (phoenix #8923; PR #9292 is in
			 * review). The README says so at length.
			 *
			 * The text is wrapped into a `TurnResult` here so the manual path and the routed one are the
			 * same payload in the same cell, which is the only way the two can be said to agree.
			 */
			send: {
				args: SendRequest,
				describe: "deliver one message now",
				run: ({text}: {readonly text: string}) => send("message", asTurn(text)),
			},
		},
		/** The tile's first line, drawn by `./state.ts` so the window's heading is one sentence. */
		title: titleLine,
		/** The tile's second line, drawn by `./state.ts` so nothing states the sentence twice. */
		status: statusLine,
	};
};

/** The authored record's own shape, so the type arguments below are read off it rather than restated. */
type Authored = ReturnType<typeof notifyProgram>;

/**
 * The row, as a config writes it: `notify({target: {kind: "ntfy", topic: "…"}})`.
 *
 * Two halves, and both are R12.1's (#9295). The **type** half is `defineProgram`'s sixth argument:
 * `Deliver` is named only in a cell's answer, which is not a place inference reaches, so the whole
 * argument list is stated once here. The **runtime** half is the spread: the compiled row's
 * `handlers` record is open, the actor dispatches an effect to it by the effect's own `type`
 * string, and `DELIVER` is that string — so a delivery is performed by the handler below and by
 * nothing else.
 *
 * The target goes into `notifyProgram`'s closure, into the live `Transport` layer, and stays in
 * both. It is not an arg, not a fill, not a field on state and not a field on the effect: an arg is
 * resolved through the registry, a fill is put on the row, a row is a record other layers read, and
 * an effect is a record the loop dispatches. A credential belongs in none of them.
 *
 * `transport` is the one seam a test moves, and it is here rather than in a test helper so that
 * what a test runs is the **binding on the row** — `row.handlers.deliver`, the function a desk
 * dispatches to — rather than a handler the test built to look like it. A config passes nothing and
 * gets `liveTransport(target, io)`.
 */
export const notify = (options: NotifyOptions, transport?: Layer.Layer<Transport>): AnyProgram => {
	const authored = notifyProgram(options);
	const row = defineProgram<
		NotifyState,
		Authored["ports"],
		Authored["update"],
		{readonly send: {readonly text: string}},
		unknown,
		Deliver
	>({
		...authored,
		label: `${checkedId(options.id)} (${options.target.kind})`,
	});
	const io = {
		fetch: options.fetch ?? ((globalThis as {fetch: Fetch}).fetch as Fetch),
		write: options.write ?? ((line: string) => console.log(line)),
	};
	return {
		...row,
		/**
		 * The window, named rather than declared. `defineProgram` compiles an authored `window` field
		 * into a `host-native` reference and seats the renderer in a map *inside the kernel process* —
		 * which a browser tab cannot reach (phoenix #8811). A `kind: "module"` reference is what the
		 * page can act on: it imports the specifier itself at boot (ADR 0359), and `./window.tsx` is
		 * what answers it.
		 *
		 * Spread onto the row rather than passed to `defineProgram`, because `renderer` is not a field
		 * the authoring surface takes — `FIELD_COMPILERS` owns that key and computes it from `window`.
		 */
		renderer: NOTIFY_WINDOW_REF,
		handlers: {
			...row.handlers,
			[DELIVER]: deliverHandler(
				transport ?? liveTransport(options.target, io),
				options.now ?? Date.now,
			),
		},
	};
};
