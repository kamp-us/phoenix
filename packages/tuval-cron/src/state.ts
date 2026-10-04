/**
 * Cron's state, and everything that is a pure function of it — the leaf both halves of this package
 * share and neither half owns.
 *
 * **Why it is a leaf.** `./cron.ts` reaches `@kampus/tuval-sdk/authoring`, which reaches the kernel;
 * `./window.tsx` runs in a browser tab, where the kernel's `node:crypto` chain is not a thing that
 * can load. The window needs the state's shape, the predicate over it and the lines drawn from it —
 * and needs none of the program. So those live here and the browser never has a path to `cron.ts`.
 * This is the split `tuval-calc` (in cansirin/monorepo) drew between its `state.ts` and its
 * `window/`, for the same reason.
 *
 * **The one import is a type and stays one.** `ProcessId` is Tuval's type-only brand — a plain
 * string at runtime — and `import type` under `verbatimModuleSyntax` emits nothing, so the built
 * `state.js` a browser loads has no import of `@kampus/tuval-sdk` at all. Widening `child` to `string`
 * instead would only move the brand's loss to `cron.ts`, where `stop(state.child)` wants it back.
 *
 * **Two fields the reducer never writes.** `id` and `cadence` are env, not state: the config chose
 * them at `cron(...)` and nothing that happens to a cron moves either. They are on the state record
 * because a window is handed one thing — this process's public state — and the schedule is the
 * first line a person opening a cron wants. The alternative is a window that cannot say what it is
 * looking at. `init` seeds them and no cell touches them.
 */

import type {ProcessId} from "@kampus/tuval-sdk/authoring";

/** One finished (or running) run, as a tile and a window both report it. */
export interface CronRun {
	readonly startedAt: number;
	readonly ok: boolean;
	/** The first line of what the job answered — the brief itself, not a status word. */
	readonly summary: string;
}

export interface CronState {
	/** What this cron is called: its program id, its graph node id, and its spell (`:<id> run`). */
	readonly id: string;
	/** How it is woken, as a person reads it: `daily 07:00`, `every 60s`, `on demand`. */
	readonly cadence: string;
	/** The job process this run started, or `null` when nothing is running. */
	readonly child: ProcessId | null;
	readonly startedAt: number | null;
	/** Newest first, bounded at `HISTORY`. */
	readonly runs: ReadonlyArray<CronRun>;
	readonly ticks: number;
}

/** How many runs the history keeps. Bounded because an unbounded log in state is a leak with a name. */
export const HISTORY = 10;

/**
 * What a run a restart cut short is written down as. A restart is not an answer, so the run it
 * interrupted is a failed one, and the summary says which failure it was.
 */
export const INTERRUPTED = "interrupted by restart";

/** The history with one more run at its head, bounded. Every cell that records a run agrees here. */
export const recorded = (runs: ReadonlyArray<CronRun>, run: CronRun): ReadonlyArray<CronRun> =>
	[run, ...runs].slice(0, HISTORY);

export const hhmmss = (at: number): string => new Date(at).toTimeString().slice(0, 8);
export const hhmm = (at: number): string => new Date(at).toTimeString().slice(0, 5);

/**
 * The status line, in one place. The row's `status` derives its self-report from this and the
 * window draws the same sentence, so a tile and a window never disagree about what a cron is doing.
 */
export const statusLine = (state: CronState): string => {
	if (state.child !== null && state.startedAt !== null) {
		return `running since ${hhmmss(state.startedAt)}`;
	}
	const last = state.runs[0];
	return last === undefined
		? "idle"
		: `last run ${hhmm(last.startedAt)} · ${last.ok ? "ok" : "failed"}`;
};

/**
 * The predicate a renderer table admits this program's state through (ADR 0358). It is exported as
 * `admits` from `./window.tsx`, which is the export the page's module loader reads.
 *
 * It checks the fields the window draws and their types, and nothing beyond them: a kernel one
 * commit older than the page sends a record missing `cadence`, and the honest answer to that is the
 * window's own refusal placeholder rather than a throw inside React.
 */
export const isCronState = (state: unknown): state is CronState => {
	if (typeof state !== "object" || state === null) return false;
	const candidate = state as Record<string, unknown>;
	return (
		typeof candidate.id === "string" &&
		typeof candidate.cadence === "string" &&
		(candidate.child === null || typeof candidate.child === "string") &&
		(candidate.startedAt === null || typeof candidate.startedAt === "number") &&
		typeof candidate.ticks === "number" &&
		Array.isArray(candidate.runs) &&
		candidate.runs.every(isCronRun)
	);
};

const isCronRun = (run: unknown): run is CronRun => {
	if (typeof run !== "object" || run === null) return false;
	const candidate = run as Record<string, unknown>;
	return (
		typeof candidate.startedAt === "number" &&
		typeof candidate.ok === "boolean" &&
		typeof candidate.summary === "string"
	);
};

// -- The window's view of all that ------------------------------------------

/** One run as the window lists it: the clock, the verdict, and the brief the job actually wrote. */
export interface CronRunView {
	/** Stable within one view: `startedAt` plus the run's place, since two runs can share a minute. */
	readonly key: string;
	readonly at: string;
	readonly ok: boolean;
	readonly summary: string;
}

/**
 * Everything the window draws, as data. Pure, so the mapping is a unit test rather than a render
 * test: what a window shows is decided here and React only puts it on the screen.
 */
export interface CronWindowView {
	/** The heading: what this cron is called. */
	readonly id: string;
	/** The schedule line, verbatim from state. */
	readonly cadence: string;
	/** `running since 07:00:03`, `last run 07:00 · ok`, or `idle` — the tile's own sentence. */
	readonly status: string;
	/** Is a job up right now? The button is disabled while one is, because a wake mid-run is dropped. */
	readonly running: boolean;
	/** The spell that does what the button does, so the window can name it. */
	readonly spell: string;
	/** Newest first, at most `HISTORY`. Empty until the first run answers. */
	readonly runs: ReadonlyArray<CronRunView>;
	/** What to say where the history would be, when there is none. */
	readonly emptyHistory: string;
}

/** The whole of the window's reading of a cron. */
export const cronView = (state: CronState): CronWindowView => ({
	id: state.id,
	cadence: state.cadence,
	status: statusLine(state),
	running: state.child !== null,
	spell: `:${state.id} run`,
	runs: state.runs.slice(0, HISTORY).map((run, index) => ({
		key: `${run.startedAt}-${index}`,
		at: hhmm(run.startedAt),
		ok: run.ok,
		summary: run.summary,
	})),
	emptyHistory:
		state.child === null ? "No runs yet." : "No runs yet — the first one is still going.",
});

/**
 * The event the window's "Run now" control sends: the same arrival `:<id> run` puts on the `run`
 * in-port, because a window and a spell asking for the same thing must reach the same cell.
 */
// A `type` and not an `interface`, deliberately: only an alias gets TypeScript's implicit index
// signature, and without one this shape is not assignable to Tuval's `Message` — which is what
// `WindowHost.dispatch` is typed at.
export type CronRunEvent = {
	readonly type: "run";
	readonly payload: Record<string, never>;
};

/** That event, built. A function rather than a constant so no caller can hold a shared object. */
export const runEvent = (): CronRunEvent => ({
	type: "run",
	payload: {},
});
