/**
 * `notify`, driven with `testProgram` and a `fetch` that is a spy — no kernel, no desk, no network.
 *
 * Two things here are worth naming before the cases.
 *
 * **The delivering handler is run by hand.** `testProgram` runs `init`, the `update` cells and the
 * derived `title`/`status` emits; it does not perform effects, so nothing it answers ever reaches
 * a handler on its own. `sent(...)` below closes that loop the way the actor does: it takes the
 * `Deliver` the last step answered, runs this package's *own* `deliverHandler` over a `Transport`
 * layer the case chose, and feeds the events it resolved to back into the run. That is the whole
 * delivery loop — an arrival takes the in-flight slot and answers `deliver`, the handler performs
 * it, the `delivered` cell records and announces — and the only thing swapped out is the socket.
 *
 * **The composition claim is tested as one half done and one half refused.** Cron now emits the
 * finished brief on a `brief` out-port carrying a whole `TurnResult`, and this program's `message`
 * port is declared over that same shipped schema — so the payload halves of the two cases at the
 * bottom pass. What still refuses the route is the kind: an authored port's `kind` carries its own
 * program's id, so no authored-to-authored route compiles (kamp-us/phoenix #8923, answered by PR
 * #9292, in review — its fit rule is exact schema equality, which is why `message` is
 * `TurnResultSchema` itself). What works today is `:notify send …`, and that has its own cases.
 * The day #9292 lands, the last `describe` is where the change shows up first.
 */

import {type TurnResult, TurnResultSchema} from "@kampus/tuval/ai-agent/ports";
import {
	type AuthoredProgram,
	emit,
	STATUS_PORT,
	send,
	TITLE_PORT,
	testProgram,
} from "@kampus/tuval/authoring";
import {BRIEF_PORT} from "@kampus/tuval-cron";
import {Effect, type Layer, Schema} from "effect";
import {describe, expect, it} from "vitest";
import config, {BLOCKED_ROUTE, desk, morningBrief, phone} from "../.tuval/tuval.config.ts";
import {
	DELIVER,
	type Deliver,
	type DeliveredEvent,
	deliver,
	deliverHandler,
	fakeTransport,
	liveTransport,
	type Transport,
} from "./deliver.ts";
import {
	DeliveredSchema,
	MessageSchema,
	type NotifyOptions,
	notify,
	notifyProgram,
	SendRequest,
} from "./notify.ts";
import {
	type Delivery,
	DROPPED,
	EMPTY_OUTBOX,
	HISTORY,
	isNotifyState,
	type NotifyState,
	OUTBOX,
	statusLine,
} from "./state.ts";
import type {Fetch, NotifyTarget, Outgoing} from "./target.ts";

/** Seven in the morning, so a status line reads the way a morning brief's does. */
const SEVEN = new Date(2026, 8, 10, 7, 0, 12).getTime();

/** The credential a real config would hold, and the string every secrecy case greps for. */
const SECRET_URL = "https://discord.test/api/webhooks/42/s3cr3t-token";

const NTFY: NotifyTarget = {kind: "ntfy", topic: "can-tuval"};

/**
 * What arrives on `message`: an AI-agent `TurnResult`, which is the port's schema exactly. A helper
 * rather than a literal at each call site because every case here cares about the text and none of
 * them about the transcript — and because writing it out once is what makes the two paths visibly
 * the same payload, the spell's and a route's.
 */
const brief = (text: string): TurnResult => ({text, items: [], ok: true});

interface Call {
	readonly url: string;
	readonly method: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string;
}

const spy = (answer: {ok: boolean; status: number} = {ok: true, status: 200}) => {
	const calls: Call[] = [];
	const fetch: Fetch = (url, init) => {
		// The `signal` is dropped rather than recorded: every request carries one (`target.ts`'s
		// `TIMEOUT`) and `target.unit.test.ts` is where that is asserted.
		calls.push({
			url,
			method: init.method,
			headers: init.headers,
			body: init.body,
		});
		return Promise.resolve(answer);
	};
	return {calls, fetch};
};

const program = (options: Partial<NotifyOptions> & {fetch?: Fetch} = {}) =>
	notifyProgram({
		target: NTFY,
		now: () => SEVEN,
		fetch: options.fetch ?? spy().fetch,
		write: () => {},
		...options,
	});

type Authored = ReturnType<typeof program>;

/**
 * The authored record, at the shape `testProgram` takes.
 *
 * `defineProgram` grew a sixth type argument in #9295 — `X`, the author's own effect — and
 * `testProgram` still stops at five, so a record whose cells answer `Answer<State, Deliver>` does
 * not fit its parameter. The cells are the same functions and the runner calls them the same way;
 * the cast is over that one type argument and nothing else, and this is the only place in the suite
 * that writes it. Filed upstream as kamp-us/phoenix
 * [#9296](https://github.com/kamp-us/phoenix/issues/9296) — the day `testProgram` takes `X`, this
 * helper becomes a plain `testProgram(...)` call and the cast goes.
 */
const driven = (authored: Authored) =>
	testProgram(
		// biome-ignore lint/plugin: the cast bridges `testProgram`'s invariant generic, not a boundary — the docblock above names #9296, whose landing deletes this helper and the cast with it.
		authored as unknown as AuthoredProgram<
			NotifyState,
			Authored["ports"],
			Authored["update"],
			{readonly send: {readonly text: string}}
		>,
	);

/** The half of `ProgramRun` these helpers need, named structurally so they restate no generics. */
interface Driven {
	readonly state: NotifyState;
	readonly effects: ReadonlyArray<unknown>;
	event(event: DeliveredEvent): Driven;
}

/**
 * A `delivered` event, written by hand — what the handler would have answered. `out` is on it
 * because an answer carries the message it answers for: that is what lets the `delivered` cell
 * write the text into the history without reading the outbox back.
 */
const answered = (
	out: Outgoing,
	attempt: {readonly ok: boolean; readonly status?: number},
	at = SEVEN,
): DeliveredEvent => ({type: "delivered", out, attempt, at});

const isDeliver = (effect: unknown): effect is Deliver =>
	(effect as {readonly type?: unknown}).type === DELIVER;

/** Every delivery the last step asked for, which is at most one — see `arming` in `notify.ts`. */
const asked = (run: Driven): ReadonlyArray<Deliver> => run.effects.filter(isDeliver);

/**
 * Perform the delivery the last step asked for, through the transport the case chose, and feed the
 * handler's own events back into the run. The one place a delivery actually happens in this suite,
 * and it runs the shipped `deliverHandler` rather than a re-statement of it.
 */
const sent = async (run: Driven, transport: Layer.Layer<Transport>) => {
	const [effect, ...rest] = asked(run);
	if (effect === undefined) throw new Error("the last step asked for no delivery");
	if (rest.length > 0) throw new Error("one step asked for more than one delivery");
	const events = await Effect.runPromise(deliverHandler(transport, () => SEVEN)(effect));
	return events.reduce<Driven>((next, event) => next.event(event), run);
};

describe("notify says what it is before anything has happened", () => {
	it("publishes its target's kind and an idle status on a fresh process", () => {
		const run = driven(program());
		expect(run.state).toEqual({
			id: "notify",
			kind: "ntfy",
			outbox: EMPTY_OUTBOX,
			deliveries: [],
			seq: 0,
		});
		expect(run.effects).toEqual([emit(TITLE_PORT, "notify · ntfy"), emit(STATUS_PORT, "idle")]);
	});

	it("names the kind and not the target, on the tile as in state", () => {
		const run = driven(program({target: {kind: "webhook", url: SECRET_URL}}));
		expect(run.effects).toContainEqual(emit(TITLE_PORT, "notify · webhook"));
		expect(run.state.kind).toBe("webhook");
	});

	it("declares a `message` in-port and a `delivered` out-port", () => {
		const row = notify({target: NTFY});
		expect(row.ports.message?.direction).toBe("in");
		expect(row.ports.delivered?.direction).toBe("out");
		expect(Object.keys(row.ports)).toEqual(expect.arrayContaining([TITLE_PORT, STATUS_PORT]));
	});
});

describe("what may arrive on `message`", () => {
	const admits = Schema.is(MessageSchema);

	/**
	 * The composition claim at the schema level, and it is now an identity rather than a fit: the
	 * port is declared over the *same object* `@kampus/tuval/ai-agent/ports` ships and cron's `brief`
	 * out-port is declared over. Nothing structural is being relied on — no open struct dropping
	 * excess keys — because #9292's route rule is exact schema equality, and only the identical
	 * schema satisfies it.
	 */
	it("is `TurnResultSchema` itself, not a struct a turn happens to satisfy", () => {
		expect(MessageSchema).toBe(TurnResultSchema);
	});

	it("takes an AI-agent `TurnResult`, and reads its `text`", () => {
		const turn: TurnResult = {
			text: "five lines\nand the rest",
			items: [],
			ok: true,
		};
		expect(admits(turn)).toBe(true);
		const run = driven(program()).send("message", turn);
		expect(run.state.outbox).toEqual({
			inflight: {key: "notify-1", text: "five lines\nand the rest"},
			queue: [],
		});
	});

	it("refuses a bare line, a half-turn, and a number — at the port, not in the cell", () => {
		expect(admits("five lines")).toBe(false);
		expect(admits({text: "five lines"})).toBe(false);
		expect(admits({ok: true})).toBe(false);
		expect(admits(42)).toBe(false);
		expect(() => driven(program()).send("message", {ok: true})).toThrow(/refused the payload/);
	});
});

describe("notify, delivering", () => {
	it("queues an arrival and says `sending` until something comes back", () => {
		const run = driven(program()).send("message", brief("five lines"));
		expect(run.state.outbox).toEqual({
			inflight: {key: "notify-1", text: "five lines"},
			queue: [],
		});
		expect(run.effects).toContainEqual(emit(STATUS_PORT, "sending"));
	});

	/**
	 * The live path, end to end: the handler runs over the **live** transport, so the target the
	 * config named reaches a real `fetch` — the spy's — through `target.ts` and not through a
	 * stand-in. It is the one case here that proves the layer a desk actually boots with.
	 */
	it("sends the queued text to the target the config named, once", async () => {
		const {calls, fetch} = spy();
		const run = await sent(
			driven(program()).send("message", brief("five lines")),
			liveTransport(NTFY, {fetch, write: () => {}}),
		);
		expect(calls).toEqual([
			{
				url: "https://ntfy.sh/can-tuval",
				method: "POST",
				headers: {"content-type": "text/plain; charset=utf-8"},
				body: "five lines",
			},
		]);
		expect(run.state.outbox).toEqual(EMPTY_OUTBOX);
	});

	it("records the delivery and announces the same record on `delivered`", async () => {
		const run = await sent(
			driven(program()).send("message", brief("five lines")),
			fakeTransport().layer,
		);
		const record = {text: "five lines", ok: true, status: 200, at: SEVEN};
		expect(run.state.deliveries).toEqual([record]);
		expect(run.effects).toContainEqual(emit("delivered", record));
		expect(run.effects).toContainEqual(emit(STATUS_PORT, "delivered 07:00 · ok"));
		// What is announced is what the out-port admits, not just a record this program built.
		expect(Schema.is(DeliveredSchema)(record)).toBe(true);
	});

	it("records a failure status and says it on the tile", async () => {
		const run = await sent(
			driven(program()).send("message", brief("five lines")),
			fakeTransport({ok: false, status: 500}).layer,
		);
		expect(run.state.deliveries).toEqual([{text: "five lines", ok: false, status: 500, at: SEVEN}]);
		expect(run.effects).toContainEqual(emit(STATUS_PORT, "delivered 07:00 · failed 500"));
	});

	it("says `failed` with no number when the request never got an answer", () => {
		const run = driven(program())
			.send("message", brief("five lines"))
			.event(answered({key: "notify-1", text: "five lines"}, {ok: false}));
		expect(run.state.deliveries).toEqual([{text: "five lines", ok: false, at: SEVEN}]);
		expect(run.effects).toContainEqual(emit(STATUS_PORT, "delivered 07:00 · failed"));
	});

	it("holds the second message until the first is answered, then asks for it", () => {
		const queued = driven(program())
			.send("message", brief("first"))
			.send("message", brief("second"));
		expect(queued.state.outbox.inflight?.text).toBe("first");
		expect(queued.state.outbox.queue.map((out) => out.text)).toEqual(["second"]);
		// The second arrival only joined the queue, so its own step asked for no delivery at all.
		expect(asked(queued)).toEqual([]);
		const after = queued.event(answered({key: "notify-1", text: "first"}, {ok: true, status: 200}));
		// The head moved into the in-flight slot, so the cell that moved it asked for that delivery.
		expect(asked(after)).toEqual([deliver({key: "notify-2", text: "second"})]);
	});

	it("asks for exactly one delivery per message, when that message takes the slot", () => {
		const first = driven(program()).send("message", brief("first"));
		expect(asked(first)).toEqual([deliver({key: "notify-1", text: "first"})]);
	});

	it("asks for nothing at all when there is nothing to send", () => {
		// A fresh notifier holds no resource and asks for no work — the old Sub's `null` deps, as an
		// effect nobody answered rather than a subscription nobody opened.
		expect(asked(driven(program()))).toEqual([]);
		const emptied = driven(program())
			.send("message", brief("only one"))
			.event(answered({key: "notify-1", text: "only one"}, {ok: true, status: 200}));
		expect(emptied.state.outbox).toEqual(EMPTY_OUTBOX);
		expect(asked(emptied)).toEqual([]);
	});

	it("bounds the history at fifty deliveries, newest first", () => {
		let run = driven(program());
		for (let index = 0; index < HISTORY + 4; index += 1) {
			run = run
				.send("message", brief(`run ${index}`))
				.event(
					answered(
						{key: `notify-${index + 1}`, text: `run ${index}`},
						{ok: true, status: 200},
						SEVEN + index,
					),
				);
		}
		expect(run.state.deliveries).toHaveLength(HISTORY);
		expect(run.state.deliveries[0]?.at).toBe(SEVEN + HISTORY + 3);
		expect(run.state.deliveries.at(-1)?.at).toBe(SEVEN + 4);
	});

	it("bounds the outbox at sixteen, the one in flight included", () => {
		let run = driven(program());
		for (let index = 0; index < OUTBOX + 3; index += 1) {
			run = run.send("message", brief(`msg ${index}`));
		}
		expect(run.state.outbox.inflight?.text).toBe("msg 0");
		expect(run.state.outbox.queue).toHaveLength(OUTBOX - 1);
		expect(run.state.outbox.queue.at(-1)?.text).toBe(`msg ${OUTBOX - 1}`);
	});
});

/**
 * The bound, as it behaves when it is actually reached. The rule is one sentence — **nothing is
 * lost quietly, and the message in flight is never what goes** — and the cases below are its two
 * halves plus the type-level reason the second half cannot be broken by accident.
 */
describe("a full outbox refuses the arrival, out loud", () => {
	/** A run holding `OUTBOX` undelivered messages: one in flight and fifteen waiting. */
	const filled = (authored: ReturnType<typeof program>) => {
		let run = driven(authored);
		for (let index = 0; index < OUTBOX; index += 1) {
			run = run.send("message", brief(`msg ${index}`));
		}
		return run;
	};

	it("records the refusal and announces the same record on `delivered`", () => {
		const run = filled(program()).send("message", brief("one too many"));
		const record = {
			text: "one too many",
			ok: false,
			reason: DROPPED,
			at: SEVEN,
		};
		expect(run.state.deliveries[0]).toEqual(record);
		expect(run.effects).toContainEqual(emit("delivered", record));
		// What it announces is what the out-port admits — the reason rides on the wire, not beside it.
		expect(Schema.is(DeliveredSchema)(record)).toBe(true);
	});

	it("keeps the message in flight, and every message already taken", () => {
		const before = filled(program());
		const after = before.send("message", brief("one too many"));
		expect(after.state.outbox).toEqual(before.state.outbox);
		// The refusal moved no message into the slot, so it asked for no delivery — the one in flight
		// keeps the delivery its own cell already asked for.
		expect(asked(after)).toEqual([]);
		expect(after.state.outbox.inflight?.key).toBe("notify-1");
		expect(after.state.outbox.queue.map((out) => out.text)).not.toContain("one too many");
	});

	it("takes the next arrival once a delivery has made room", () => {
		const run = filled(program())
			.send("message", brief("one too many"))
			.event(answered({key: "notify-1", text: "msg 0"}, {ok: true, status: 200}))
			.send("message", brief("room now"));
		expect(run.state.outbox.queue.at(-1)?.text).toBe("room now");
	});

	/**
	 * The structural half. `Outbox` holds the message in flight in a *field*, not at index zero of an
	 * array, so there is no index by which an arrival could reach it — which is why the invariant is
	 * not a bounds check somebody has to keep correct. This case states it over the type.
	 */
	it("gives an arrival no way to reach the message in flight", () => {
		const run = filled(program());
		const inflight = run.state.outbox.inflight;
		expect(inflight).not.toBeNull();
		for (let index = 0; index < 5; index += 1) {
			expect(run.send("message", brief(`refused ${index}`)).state.outbox.inflight).toBe(inflight);
		}
	});

	it("says the reason on the tile rather than a bare `failed`", () => {
		// While something is still in flight the tile reads `sending`, which is the truthful line —
		// the refusal is in the history and on the wire. It becomes the sentence once the outbox is
		// empty, which is the state a reader is actually looking at when they wonder what went wrong.
		const refused = filled(program()).send("message", brief("one too many"));
		expect(statusLine(refused.state)).toBe("sending");
		expect(statusLine({...refused.state, outbox: EMPTY_OUTBOX})).toBe(
			`delivered 07:00 · ${DROPPED}`,
		);
	});
});

/**
 * **Subs observe, handlers perform** (#8716 R12.1), and this is that sentence as cases. Delivery
 * used to run inside a dep-keyed Sub; it now runs in a handler the compiled row is spread with
 * (#9295), and the three things that has to be true of are the seam (the row carries a handler
 * under the key the actor dispatches on), the round trip (the handler is invoked with the effect
 * and its events reach `update`), and the absence (no Sub is left anywhere).
 */
describe("delivery runs in an effect handler, not a Sub", () => {
	it("carries a `deliver` handler on the row, beside the six kernel ones", () => {
		const row = notify({target: NTFY});
		const handlers = row.handlers as Readonly<Record<string, unknown>>;
		// The key is the effect's own `type`, which is what `HostHandlers` is keyed by and what the
		// actor looks a handler up under — so the constant is the agreement, not a matching literal.
		expect(Object.keys(handlers)).toEqual(
			expect.arrayContaining([DELIVER, "emit", "spawn", "send", "ask", "reply", "stop"]),
		);
		expect(typeof handlers[DELIVER]).toBe("function");
	});

	it("declares no Subs at all", () => {
		expect(notify({target: NTFY}).subs).toBeUndefined();
		expect("subs" in program()).toBe(false);
	});

	/**
	 * The round trip, and the case this refactor exists for: the effect a cell answered is handed to
	 * the binding **on the row** — the function a desk dispatches to, reached by the key the actor
	 * looks it up under — and the events it resolves to land in `update` and move the state. Every
	 * link is the shipped one except the socket, which is why `notify` takes the transport.
	 */
	it("invokes the handler on the row with the effect, and its events reach `update`", async () => {
		const transport = fakeTransport({ok: true, status: 201});
		const queued = driven(program()).send("message", brief("five lines"));
		const [effect] = asked(queued);
		expect(effect).toEqual(deliver({key: "notify-1", text: "five lines"}));

		const handler = (
			notify({target: NTFY, now: () => SEVEN}, transport.layer).handlers as Readonly<
				Record<string, (cmd: Deliver) => Effect.Effect<ReadonlyArray<DeliveredEvent>>>
			>
		)[DELIVER];
		if (handler === undefined) throw new Error("the row carries no handler");

		const events = await Effect.runPromise(handler(effect as Deliver));
		// The handler was invoked with the effect's own message, and with that and nothing else.
		expect(transport.sent).toEqual([{key: "notify-1", text: "five lines"} satisfies Outgoing]);
		// It answers its follow-ups as a list, which is what a `HostHandlers` handler owes the actor.
		expect(events).toEqual([
			answered({key: "notify-1", text: "five lines"}, {ok: true, status: 201}),
		]);

		// And fed back in — which is what the actor does with them — they move the program.
		const after = events.reduce<Driven>((next, event) => next.event(event), queued);
		expect(after.state.outbox).toEqual(EMPTY_OUTBOX);
		const record = {text: "five lines", ok: true, status: 201, at: SEVEN};
		expect(after.state.deliveries).toEqual([record]);
		expect(after.effects).toContainEqual(emit("delivered", record));
	});

	it("carries the message on the effect and the target nowhere near it", () => {
		const secret = driven(
			program({
				target: {
					kind: "webhook",
					url: SECRET_URL,
					headers: {Authorization: "Bearer hunter2"},
				},
			}),
		).send("message", brief("five lines"));
		// An effect is dispatched, named in a `HandlerFailed` and read by anything watching the loop.
		// A credential belongs in none of those, so the target lives in the live `Transport` layer.
		expect(JSON.stringify(asked(secret))).toBe(
			JSON.stringify([deliver({key: "notify-1", text: "five lines"})]),
		);
	});
});

describe("no secret is ever written down", () => {
	/**
	 * The rule this package is most likely to break by accident, so it is checked over the whole
	 * record rather than field by field: a webhook URL is a credential, and so is an `Authorization`
	 * header. Tuval checkpoints state to disk and hands it to a window; anything on this record is a
	 * thing written down and shown.
	 */
	it("keeps the URL and the headers out of state and out of what it announces", async () => {
		const authored = program({
			target: {
				kind: "webhook",
				url: SECRET_URL,
				headers: {Authorization: "Bearer hunter2"},
			},
		});
		const run = await sent(
			driven(authored).send("message", brief("five lines")),
			liveTransport(
				{
					kind: "webhook",
					url: SECRET_URL,
					headers: {Authorization: "Bearer hunter2"},
				},
				{fetch: spy().fetch, write: () => {}},
			),
		);
		const written = JSON.stringify({
			state: run.state,
			effects: run.effects,
		});
		expect(written).not.toContain("s3cr3t-token");
		expect(written).not.toContain("hunter2");
		expect(written).not.toContain("discord.test");
		// What it does carry is the word `webhook`, which is what a tile needs and nothing to spend.
		expect(run.state.kind).toBe("webhook");
	});

	it("keeps the ntfy topic out of state, because a topic is a read *and* write credential", () => {
		const run = driven(program({target: {kind: "ntfy", topic: "can-tuval"}}));
		expect(JSON.stringify(run.state)).not.toContain("can-tuval");
	});
});

describe("notify, restarted", () => {
	it("asks to reconcile on every restore, and re-reads the kind off the config", () => {
		const stale: NotifyState = {
			id: "notify",
			kind: "stdout",
			outbox: EMPTY_OUTBOX,
			deliveries: [],
			seq: 3,
		};
		const authored = program();
		expect(authored.resume(stale)).toEqual([{type: "restored"}]);
		const [back] = authored.update.restored(stale, {type: "restored"});
		expect(back.kind).toBe("ntfy");
		expect(back.seq).toBe(3);
	});

	/**
	 * The one migration this package has. A checkpoint written before a delivery carried its `text`
	 * holds records the window's `admits` refuses — and `admits` is all-or-nothing, so three such
	 * records at the head would make the window refuse to draw the fifty good ones behind them. They
	 * are dropped here, once, on the way back in.
	 */
	it("drops the deliveries written before the record carried its text", () => {
		const stale: NotifyState = {
			id: "notify",
			kind: "ntfy",
			outbox: EMPTY_OUTBOX,
			// Two shapes in one history: what a desk wrote yesterday, and what it writes now.
			deliveries: [
				// biome-ignore lint/plugin: the cast IS the subject — this is what a checkpoint written before `text` existed holds, and the test is that `restored` drops it.
				{ok: true, status: 204, at: SEVEN} as unknown as Delivery,
				{text: "the desk is up", ok: true, status: 200, at: SEVEN - 1},
			],
			seq: 2,
		};
		const [back] = program().update.restored(stale, {type: "restored"});
		expect(back.deliveries).toEqual([
			{text: "the desk is up", ok: true, status: 200, at: SEVEN - 1},
		]);
		// Which is the whole point of doing it here: what comes out is a state the window mounts over.
		expect(isNotifyState(back)).toBe(true);
		expect(isNotifyState(stale)).toBe(false);
	});

	it("keeps an undelivered outbox, so a message the desk took is sent when it comes back", () => {
		const interrupted = driven(program()).send("message", brief("five lines"));
		const authored = program();
		const [back, effects] = authored.update.restored(interrupted.state, {
			type: "restored",
		});
		expect(back.outbox).toEqual({
			inflight: {key: "notify-1", text: "five lines"},
			queue: [],
		});
		// And it is put back on the wire by this cell and by nothing else: a restored process starts
		// with no effects, so without this the interrupted message would sit in the outbox for ever.
		// Which is at-least-once and deliberately so: a duplicate beats a dropped notification.
		expect(effects).toContainEqual(deliver({key: "notify-1", text: "five lines"}));
	});

	it("asks for no delivery when the outbox it came back to is empty", () => {
		const fresh = driven(program());
		const [, effects] = program().update.restored(fresh.state, {
			type: "restored",
		});
		expect(effects.filter(isDeliver)).toEqual([]);
	});

	/**
	 * The dependency this cell has, pinned rather than left latent: it asks again **every time it is
	 * asked**, so one resume is one duplicate at worst and two resumes would be two POSTs. The kernel
	 * sends `resume` once per restore, which is what makes that ceiling true.
	 *
	 * It is not guarded on state on purpose. A `delivering` flag would be checkpointed, so it comes
	 * back `true` on a desk that died mid-request and suppresses exactly the re-delivery this cell
	 * exists to make — which trades the duplicate this program chose for the silent drop it refuses.
	 */
	it("asks again on every `restored`, which is what one resume per restore buys", () => {
		const interrupted = driven(program()).send("message", brief("five lines"));
		const authored = program();
		const once = authored.update.restored(interrupted.state, {
			type: "restored",
		});
		expect(once[1].filter(isDeliver)).toEqual([deliver({key: "notify-1", text: "five lines"})]);
		// Fed the same event a second time it asks a second time — so the ceiling is the kernel's
		// single `resume`, not a check in here. `notify.ts`'s `restored` cell says why at length.
		const twice = authored.update.restored(once[0], {type: "restored"});
		expect(twice[1].filter(isDeliver)).toEqual([deliver({key: "notify-1", text: "five lines"})]);
	});
});

describe("notify's `send` command", () => {
	it("sends to its own program's `message` port and asks for nothing else", () => {
		const run = driven(program()).call("send", {text: "five lines"});
		expect(run.effects).toEqual([send("message", brief("five lines"))]);
		expect(run.state.outbox).toEqual(EMPTY_OUTBOX);
	});

	it("queues the message when that payload reaches the port", () => {
		expect(driven(program()).send("message", brief("five lines")).state.outbox.inflight?.text).toBe(
			"five lines",
		);
	});

	it("registers the spell under the program id, which is what `:notify send` resolves", () => {
		expect(notify({target: NTFY}).spells?.map((spell) => spell.path)).toContainEqual(["send"]);
	});
});

describe("naming a notifier", () => {
	it("defaults to `notify`, and takes a word when a config holds more than one", () => {
		expect(notify({target: NTFY}).id).toBe("notify");
		expect(notify({target: NTFY}).label).toBe("notify (ntfy)");
		const named = notify({id: "phone", target: NTFY});
		expect(named.id).toBe("phone");
		expect(named.label).toBe("phone (ntfy)");
		expect(driven(program({id: "phone"})).effects).toContainEqual(emit(TITLE_PORT, "phone · ntfy"));
	});

	it("refuses an id that is not a word, at the config call rather than at boot", () => {
		expect(() => notify({id: "", target: NTFY})).toThrow(/non-empty word/);
		expect(() => notify({id: "   ", target: NTFY})).toThrow(/non-empty word/);
		// A space would break `:my notify send` into a spell plus an argument, which addresses nothing.
		expect(() => notify({id: "my notify", target: NTFY})).toThrow(/no spaces/);
	});
});

/**
 * The consumer path, end to end and from outside: the fixture `.tuval/tuval.config.ts` builds its
 * rows through both packages' own entries, exactly as a user's config does.
 */
describe("a user's `.tuval/tuval.config.ts`", () => {
	it("carries a cron and two notifiers, each its own program and its own node", () => {
		expect(config.programs.map((row) => row.id)).toEqual(["morning-brief", "notify", "desk"]);
		expect(config.graph.nodes.map((node) => node.id)).toEqual(["morning-brief", "notify", "desk"]);
		expect(phone.label).toBe("notify (ntfy)");
		expect(desk.label).toBe("desk (stdout)");
	});

	/**
	 * The fixture's whole point is that it is a config a desk would actually boot, and the one thing
	 * that would stop it is the route below being in it: `IncompatibleRoute` is raised at `compile`,
	 * before a single program starts. So this reads the **default export** — the object a desk is
	 * handed — and asserts the blocked route is not reachable from it, by identity and by shape.
	 */
	it("boots: the default export carries no route at all, `BLOCKED_ROUTE` least of all", () => {
		expect(config.version).toBe(1);
		expect(config.graph.nodes).not.toContain(BLOCKED_ROUTE);
		for (const node of config.graph.nodes) {
			expect(node.on).toEqual([]);
			// Every node names a program the config actually starts, which is the other boot condition.
			expect(config.programs.map((row) => row.id)).toContain(node.program);
		}
		// And the route itself is exported, unwired, so the day #8923 lands it moves into `nodes`.
		expect(BLOCKED_ROUTE.on[0]?.to).toEqual({
			node: "notify",
			port: "message",
		});
	});

	it("gives each notifier its own spell, which is the manual path off the desk", () => {
		expect(phone.spells?.map((spell) => spell.path)).toContainEqual(["send"]);
		expect(desk.spells?.map((spell) => spell.path)).toContainEqual(["send"]);
	});
});

/**
 * **The composition this package exists for: what is in place, and the one thing still missing.**
 *
 * All three cases read the real rows. The first two are the halves that now hold — cron has a
 * `brief` out-port and the two ends share one schema object — and the third is the refusal as it
 * stands, so the day #9292 lands this file fails and says exactly which half moved.
 */
describe("cron's brief reaching notify's `message` port", () => {
	it("has something to leave from: cron declares a `brief` out-port", () => {
		// Cron's `result` is still a cell over the reply its spawned job sends back — an internal
		// arrival, not a port. What a graph node can write is `{port: "brief", to: …}`, added by #416
		// beside the kernel's two self-report lines.
		expect(morningBrief.ports.result).toBeUndefined();
		const out = Object.entries(morningBrief.ports)
			.filter(([, schema]) => schema.direction === "out")
			.map(([name]) => name)
			.sort();
		expect(out).toEqual([BRIEF_PORT, STATUS_PORT, TITLE_PORT].sort());
		expect(BLOCKED_ROUTE.on[0]).toEqual({
			port: BRIEF_PORT,
			to: {node: "notify", port: "message"},
		});
	});

	/**
	 * The payload half of the fit, read off both compiled rows rather than off either package's
	 * source. #9292's rule is exact schema equality, so "a turn would decode here" is not enough and
	 * is not what is asserted: the two ports must publish the *same* schema object, and they do.
	 */
	it("agrees on the payload exactly: both ends publish `TurnResultSchema` itself", () => {
		expect(morningBrief.ports[BRIEF_PORT]?.schema).toBe(TurnResultSchema);
		expect(phone.ports.message?.schema).toBe(TurnResultSchema);
		expect(phone.ports.message?.schema).toBe(morningBrief.ports[BRIEF_PORT]?.schema);
	});

	it("is refused on the kind: an authored port's kind carries its own program's id", () => {
		// kamp-us/phoenix #8923, `p1`, answered by PR #9292 and in review. `portKind` is
		// `<program>/<port>` and `resolveRoute` requires the two ends' kinds to be *identical*, so no
		// route between two `defineProgram` programs compiles yet, whatever the payloads say.
		expect(phone.ports.message?.kind).toBe("notify/message");
		expect(desk.ports.message?.kind).toBe("desk/message");
		expect(morningBrief.ports[BRIEF_PORT]?.kind).toBe("morning-brief/brief");
		expect(phone.ports.message?.kind).not.toBe(desk.ports.message?.kind);
		// …even though every one of them admits exactly the same payload. The refusal is about the name.
		const turn: TurnResult = {text: "five lines", items: [], ok: true};
		expect(phone.ports.message?.accepts(turn)).toBe(true);
		expect(desk.ports.message?.accepts(turn)).toBe(true);
		expect(morningBrief.ports[BRIEF_PORT]?.accepts(turn)).toBe(true);
	});
});

describe("the send spell's argument is readable by the desk", () => {
	// The desk reads positional parameters off the struct's properties; a bare string schema has
	// none, so every argument to the spell was refused with "no further arguments" (live, 2026-09-16).
	it("declares one rest parameter named text, so unquoted text binds as a whole", () => {
		// The same document the desk's registry builds (`commands/registry.ts`): the rest annotation
		// is carried only when asked for by key.
		const document = Schema.toJsonSchemaDocument(SendRequest, {
			includeAnnotationKey: (key) => key === "x-command-rest",
		}) as {
			schema: {
				properties?: Record<string, Record<string, unknown>>;
				required?: ReadonlyArray<string>;
			};
		};
		const text = document.schema.properties?.text;
		expect(text).toBeDefined();
		expect(text?.["x-command-rest"]).toBe(true);
		expect(text?.type).toBe("string");
		expect(document.schema.required).toEqual(["text"]);
	});
});
