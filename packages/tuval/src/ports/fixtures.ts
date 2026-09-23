/**
 * Test fixtures for the ports slice: a program whose ports are the only thing that varies. Each
 * program's private Msg is deliberately distinct from every port payload, which is what the
 * type-level test in `boundary.unit.test.ts` leans on.
 */

import {type Cmd, defineMachine} from "@demlik/tea";
import {Schema} from "effect";
import type {AnyProgram, PortBound, PortSchema, Program} from "../registry/program.ts";
import {ProgramId} from "../registry/program.ts";

export type State = {readonly count: number};
export type Msg = {readonly type: "tick"};

export const counter = defineMachine<State, Msg, Cmd<never>, never, unknown>({
	init: (loaded) => [loaded ?? {count: 0}, []],
	update: {tick: (state) => [{count: state.count + 1}, []]},
});

export const isNumber = (p: unknown): p is number => typeof p === "number";
export const isString = (p: unknown): p is string => typeof p === "string";

export const bound: PortBound = {capacity: 8, overflow: "suspend"};

export const program = (id: string, ports: Readonly<Record<string, PortSchema>>): AnyProgram =>
	({
		id: ProgramId.make(id),
		core: counter,
		ports,
		handlers: {},
		capabilities: [],
		identity: {package: "@kampus/tuval", program: id, version: "1.0.0", digest: `sha256:${id}`},
		placement: {host: "local"},
	}) satisfies Program<State, Msg, Cmd<never>, never, unknown, never, never>;

/** Emits numbers on `ticks` (`tick/v1`). */
export const producer = program("producer", {
	ticks: {kind: "tick/v1", direction: "out", accepts: isNumber},
});

/** Consumes numbers on `ticks` (`tick/v1`) under `bound`. */
export const consumer = (id = "consumer", inBound: PortBound = bound) =>
	program(id, {
		ticks: {kind: "tick/v1", direction: "in", accepts: isNumber, bound: inBound},
	});

/** Consumes strings on `verdicts` (`verdict/v1`): the kind spike #7379 refused a tick route into. */
export const judge = program("judge", {
	verdicts: {kind: "verdict/v1", direction: "in", accepts: isString, bound},
});

/**
 * The structural half (ADR 0395). These rows publish the schema beside the predicate, the way a
 * `defineProgram` row does, and they deliberately do NOT share a kind — `portKind` mints one per
 * declaring program, so two authored programs never can, which is the whole of what #8923 was.
 */
export const PrSchema = Schema.Number;
export const BriefSchema = Schema.Struct({
	text: Schema.String,
	items: Schema.Number,
	ok: Schema.Boolean,
});
export const MessageSchema = Schema.Struct({text: Schema.String});

/** Announces a number on `pr`, under its own program's kind. */
export const authoredDesk = program("desk", {
	pr: {kind: "desk/pr", direction: "out", accepts: Schema.is(PrSchema), schema: PrSchema},
});

/** Takes a number on `pr`, under a kind nothing else spells. Fits `authoredDesk` by payload only. */
export const authoredReview = program("pr-review", {
	pr: {
		kind: "pr-review/pr",
		direction: "in",
		accepts: Schema.is(PrSchema),
		bound,
		schema: PrSchema,
	},
});

/** Announces `{text, items, ok}` on `brief`: the live cron consumer's out-port, in miniature. */
export const authoredCron = program("cron", {
	brief: {
		kind: "cron/brief",
		direction: "out",
		accepts: Schema.is(BriefSchema),
		schema: BriefSchema,
	},
});

/** Takes `{text}` on `message`: the notify consumer's in-port, which `brief` does not fit. */
export const authoredNotify = program("notify", {
	message: {
		kind: "notify/message",
		direction: "in",
		accepts: Schema.is(MessageSchema),
		bound,
		schema: MessageSchema,
	},
});

/** Kind-equal with `producer`, and publishing a schema that does not fit its number payload. */
export const schemaJudge = program("schema-judge", {
	ticks: {
		kind: "tick/v1",
		direction: "in",
		accepts: Schema.is(MessageSchema),
		bound,
		schema: MessageSchema,
	},
});

/** Kind-equal with `producer` and publishing the same number payload: both rules say yes. */
export const schemaCounter = program("schema-counter", {
	ticks: {kind: "tick/v1", direction: "out", accepts: Schema.is(PrSchema), schema: PrSchema},
});
