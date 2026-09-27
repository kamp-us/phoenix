/**
 * The two fields an author declares as functions of state, and the compiler that turns each into
 * something the kernel already carries: `title` and `status` onto the two generic self-report
 * out-ports (`../process/self-report.ts`).
 *
 * Declaring neither is a whole program. A program with no `title` reads back as having none;
 * nothing here is enforced, and nothing here throws.
 *
 * **A window is not one of these fields, and cannot be** (#8946, ruled 2026-09-20). A window is a
 * React component, this module is compiled by Node inside the kernel process, and the page is a
 * browser tab that cannot reach anything the kernel compiled. So a program names its window by
 * module specifier — `renderer: {kind: "module", ref}` on the authored record, ADR 0359 — and the
 * page imports that module itself. What a window shares with its program travels the same way it
 * would from any other browser module: a type-only import, or a leaf file that imports nothing.
 *
 * **A derived line crosses its port only when it moves.** The kernel latches the newest line a
 * process emits on each port (#8718), so a transition that leaves the title where it was has
 * nothing to publish — emitting it anyway would spend a wire message per event to restate a value
 * every reader already holds.
 *
 * **A restored process publishes nothing at all, so it does not go through a port.** Demlik refuses
 * Cmds from a rehydrating `init` and the diff above stays silent on an unmoved line, which between
 * them left a restored stable title unreadable (#8812). `compileDerivedLines` answers the third
 * seam instead: the kernel asks the row what its loaded state derives and seeds the latch directly
 * (`../process/self-report.ts`), so the restore costs no wire message and the diff keeps its job.
 *
 */

import {STATUS_PORT, statusPort, TITLE_PORT, titlePort} from "../process/self-report.ts";
import type {PortSchema} from "../registry/program.ts";
import type {
	Answer,
	AnyAuthoredProgram,
	ArrivalEventOf,
	ArrivingPortNames,
} from "./define-program.ts";
import {emit, type ProgramEffect} from "./effect.ts";
import type {PortDecls} from "./port.ts";

/** One line about the program, read off its state. Pure: the compiler calls it twice per transition. */
export type DerivedLine<S> = (state: S) => string;

/**
 * One cell's event. A cell that never names its own — the common shape for an event carrying
 * nothing but its tag — infers `unknown` there, and `unknown` in the union would make every object
 * sendable; the cell's key is the event's tag, so that cell contributes the bare tagged event.
 */
type EventOf<K, H> = H extends (state: any, event: infer E) => any
	? unknown extends E
		? {readonly type: K}
		: E
	: never;

/**
 * Every event this program's own `update` holds a cell for: the author's own, read back off the
 * cells they wrote, and one per arriving port.
 *
 * It is what a window module types its `WindowHost` dispatch against, so a window sending an event
 * no cell answers is a compile error where the window is written. A window reaches it the one way a
 * browser module may reach a program file at all: `import type`, which a bundler erases before it
 * can pull the kernel in behind it (#8946). `../demo/module-window.tsx` is the worked shape.
 */
export type ProgramEvent<D extends PortDecls, U> =
	| {[K in keyof U]: EventOf<K & string, U[K]>}[keyof U]
	| {
			[K in ArrivingPortNames<D>]: ArrivalEventOf<D, K & keyof D & string>;
	  }[ArrivingPortNames<D>];

/** Is this one of the kernel's two generic self-report ports? */
export const isSelfReportPort = (port: string): boolean =>
	port === TITLE_PORT || port === STATUS_PORT;

type Derivation = readonly [port: string, line: DerivedLine<unknown>];

const derivations = (authored: AnyAuthoredProgram): ReadonlyArray<Derivation> => [
	...(authored.title === undefined ? [] : [[TITLE_PORT, authored.title] as const]),
	...(authored.status === undefined ? [] : [[STATUS_PORT, authored.status] as const]),
];

/**
 * The self-report ports a program earns by deriving a line for one. The row's port has to be there
 * for the latch to record: it reads `ports["title@1"].direction` off the row before it keeps a line
 * (`../process/self-report.ts`), so a derived title on a row that declares no port is a line nobody
 * ever reads back.
 */
export const selfReportPorts = (
	authored: AnyAuthoredProgram,
): Readonly<Record<string, PortSchema>> => ({
	...(authored.title === undefined ? {} : {[TITLE_PORT]: titlePort}),
	...(authored.status === undefined ? {} : {[STATUS_PORT]: statusPort}),
});

/** Every derived line, emitted. What a fresh process publishes before anything has happened to it. */
export const initialSelfReport = (
	authored: AnyAuthoredProgram,
	state: unknown,
): ReadonlyArray<ProgramEffect> =>
	derivations(authored).map(([port, line]) => emit(port, line(state)));

/**
 * Every derived line as a function of state, keyed by its port — what the kernel seeds a restored
 * process's self-report latch from (#8812), and the only publisher that path reaches.
 *
 * `undefined` for a program deriving neither line, which leaves the row field off entirely: such a
 * program is never asked for a line and pays nothing on the restore path.
 */
export const compileDerivedLines = (
	authored: AnyAuthoredProgram,
): ((state: unknown) => Readonly<Record<string, string>>) | undefined => {
	const derived = derivations(authored);
	if (derived.length === 0) return undefined;
	return (state: unknown) =>
		Object.fromEntries(derived.map(([port, line]) => [port, line(state)] as const));
};

const movedLines = (
	derived: ReadonlyArray<Derivation>,
	previous: unknown,
	next: unknown,
): ReadonlyArray<ProgramEffect> =>
	derived.flatMap(([port, line]) => {
		const answer = line(next);
		return line(previous) === answer ? [] : [emit(port, answer)];
	});

type Cell = (state: unknown, event: unknown) => Answer<unknown>;

/**
 * The authored `update`, with every cell asked for the derived lines its transition moved. A
 * program deriving neither line is handed its own table back untouched, so it pays nothing for a
 * field it never declared.
 */
export const withSelfReport = <U>(authored: AnyAuthoredProgram, update: U): U => {
	const derived = derivations(authored);
	if (derived.length === 0) return update;
	const cells = update as Readonly<Record<string, Cell>>;
	return Object.fromEntries(
		Object.entries(cells).map(([type, cell]) => [
			type,
			(state: unknown, event: unknown): Answer<unknown> => {
				const [next, effects] = cell(state, event);
				const moved = movedLines(derived, state, next);
				return moved.length === 0 ? [next, effects] : [next, [...effects, ...moved]];
			},
		]),
	) as U;
};
