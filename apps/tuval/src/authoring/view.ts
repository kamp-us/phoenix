/**
 * The three fields an author declares as functions of state, and the compiler that turns each into
 * something the kernel already carries: `title` and `status` onto the two generic self-report
 * out-ports (`../process/self-report.ts`), and `window` into the row's renderer reference plus the
 * renderer that reference names.
 *
 * Declaring none of the three is a whole program. A headless program has no window and a program
 * with no `title` reads back as having none; nothing here is enforced, and nothing here throws.
 *
 * **A derived line crosses its port only when it moves.** The kernel latches the newest line a
 * process emits on each port (#8718), so a transition that leaves the title where it was has
 * nothing to publish — emitting it anyway would spend a wire message per event to restate a value
 * every reader already holds.
 *
 * **The window bridge is a function of state, because a host publishes state as a stream.** A
 * `WindowHost` carries `readProcess` and no synchronous read (`../shell/window/host.ts`), and this
 * layer is on the kernel's React-free lens, so it cannot subscribe on the author's behalf. The
 * compiled renderer therefore binds `send` to the host once and answers the author's view as a
 * function of the state the mounting surface reads — which is the subscription `readsState` already
 * owns on the page side (`../page/readable-state.tsx`). The author writes `{state, send}` either
 * way and names neither `WindowHost` nor the renderer table.
 */

import {Effect} from "effect";
import type {Message} from "../process/process.ts";
import {STATUS_PORT, statusPort, TITLE_PORT, titlePort} from "../process/self-report.ts";
import type {PortSchema, ProgramId, RendererKind, RendererRef} from "../registry/program.ts";
import type {
	AnyWindowRenderer,
	ViewState,
	WindowHost,
	WindowRenderer,
} from "../shell/window/index.ts";
import {windowRenderer} from "../shell/window/index.ts";
import type {
	Answer,
	AnyAuthoredProgram,
	ArrivalEventOf,
	ArrivingPortNames,
	CompileContext,
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
 * cells they wrote, and one per arriving port. It is what `send` inside a window is typed against,
 * so a window sending an event no cell answers is a compile error where the window is written.
 */
export type ProgramEvent<D extends PortDecls, U> =
	| {[K in keyof U]: EventOf<K & string, U[K]>}[keyof U]
	| {
			[K in ArrivingPortNames<D>]: ArrivalEventOf<D, K & keyof D & string>;
	  }[ArrivingPortNames<D>];

/** What an authored window is handed: this process's state, and a way into its own events. */
export interface WindowView<S, E> {
	readonly state: S;
	readonly send: (event: E) => void;
}

export type AuthoredWindow<S, D extends PortDecls, U, Out> = (
	view: WindowView<S, ProgramEvent<D, U>>,
) => Out;

/** What `window` compiles to: the author's view, bound to a host and left as a function of state. */
export type AuthoredWindowRenderer<S, Out> = WindowRenderer<
	(state: S) => Out,
	S,
	Message,
	ViewState
>;

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

const WINDOW_KIND: RendererKind = "host-native";

/** The reference an authored window takes. Derived from the program id, so no author writes one. */
export const authoredWindowRef = (id: ProgramId): RendererRef => ({
	kind: WINDOW_KIND,
	ref: `${id}/window`,
});

/**
 * The renderers `defineProgram` has compiled, by the reference their rows name. It is the table an
 * author never edits: compiling a program seats its window, and re-compiling the same program (a
 * hot reload) replaces that one seat rather than adding a second.
 */
const seated = new Map<string, AnyWindowRenderer>();

export const authoredWindowRenderers = (): Readonly<Record<string, AnyWindowRenderer>> =>
	Object.fromEntries(seated);

/** An authored window with its program's types erased — what the compiler is handed. */
type ErasedWindow = (view: WindowView<unknown, Message>) => unknown;

/**
 * `send`, bound to the host. It is typed at `Message` — the row's own erasure of a program's
 * private Msg type — and the author's own event union is what `AuthoredWindow` types their side at,
 * so the narrowing lives where the program is written and nothing is cast to recover it here.
 */
const sendThrough =
	(host: WindowHost<unknown, Message, ViewState>) =>
	(event: Message): void => {
		void Effect.runFork(host.dispatch(event));
	};

/**
 * The row's renderer reference for an authored `window`, with the renderer it names seated on the
 * way past. `undefined` for a program declaring no window, which leaves the field off the row and
 * is how a headless program stays one.
 */
export const compileWindow = (
	authored: AnyAuthoredProgram,
	context: CompileContext,
): RendererRef | undefined => {
	// The row erases a program's private types and so does this compiler: the author's own state and
	// event union are checked where `AuthoredWindow` is written, and nothing recovers them here.
	const window = authored.window as ErasedWindow | undefined;
	if (window === undefined) return undefined;
	const reference = authoredWindowRef(context.id);
	seated.set(
		reference.ref,
		windowRenderer(
			WINDOW_KIND,
			(host: WindowHost<unknown, Message, ViewState>) =>
				(state: unknown): unknown =>
					window({state, send: sendThrough(host)}),
		),
	);
	return reference;
};
