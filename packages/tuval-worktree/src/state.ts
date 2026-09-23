/**
 * Worktree's state, and everything that is a pure function of it — the leaf both halves of this
 * package share and neither half owns.
 *
 * **Why it is a leaf.** `./worktree.ts` reaches `@kampus/tuval-sdk/authoring`, which reaches the
 * kernel; `./window.tsx` runs in a browser tab, where the kernel's `node:crypto` chain is not a
 * thing that can load. The window needs the state's shape, the predicate over it and the lines
 * drawn from it — and needs none of the program. So those live here and the browser never has a
 * path to `worktree.ts`. This is the split `@kampus/tuval-cron` drew between its `state.ts` and
 * its `window.tsx`, for the same reason and in the same place.
 *
 * **The one import is a type and stays one.** `ProcessId` is Tuval's type-only brand — a plain
 * string at runtime — and `import type` under `verbatimModuleSyntax` emits nothing, so the built
 * `state.js` a browser loads has no import of `@kampus/tuval-sdk` at all.
 *
 * **Four fields the reducer never writes.** `repo`, `repoName`, `root` and `base` are env, not
 * state: the config chose them at `worktree(...)` and nothing that happens to a worktree moves
 * any of them. They are on the state record because a window is handed one thing — this process's
 * public state — and "which repo am I looking at" is the first line a person opening it wants.
 * `init` seeds them, `restored` re-seeds them from the config, and no other cell touches them.
 */

import type {ProcessId} from "@kampus/tuval-sdk/authoring";

/**
 * Where a worktree is in its life. Five words and no sixth, because every one of them is a
 * different thing for the tile to say and a different set of controls for the window to offer.
 *
 * `provisioning` and `closing` are the two with something in flight — `closing` covers both halves
 * of a close, the wait for the agent's ending and the removal itself; `open` is the steady state;
 * `failed` is a provision that did not finish, kept rather than dropped because a disappearing
 * row is the failure mode this package exists to argue against; `gone` is a record whose directory
 * is not on disk any more — recorded, never deleted, because the record is the only evidence left
 * that the directory was ever supposed to be there.
 */
export type WorktreeStatus = "provisioning" | "open" | "closing" | "failed" | "gone";

/** One provisioned set: the four declared inputs, as they were actually resolved. */
export interface WorktreeRecord {
	/** What the person called it. The key, the branch suffix, and the directory name. */
	readonly name: string;
	/** The worktree directory, absolute. */
	readonly path: string;
	/** The branch the worktree is checked out on — `can/<name>` unless the config says otherwise. */
	readonly branch: string;
	/** The TCP port the probe found free, written into the worktree's `.env`. */
	readonly port: number | null;
	readonly status: WorktreeStatus;
	/** The agent session running *inside* this worktree, or `null` when none is up. */
	readonly agent: ProcessId | null;
	/** The last thing worth saying about this worktree — a failure, or an agent's first line. */
	readonly detail: string | null;
	readonly openedAt: number;
}

/**
 * What is in flight, and the only thing on state that is not a fact about the world.
 *
 * **It is a mutex, and that is now the whole of its job.** The work itself is an effect a cell
 * answers and a handler runs (`./worktree.ts`), so nothing reads this to decide what to *do*; what
 * reads it is the `open` cell refusing a second job, the status line saying what is happening, the
 * `provisioned` cell reading back the brief its `open` carried, and the `restored` cell writing an
 * interrupted job down as failed. One at a time, deliberately: `git worktree add` on one repo is
 * not a thing to run twice concurrently, and a port probe that raced another provision would hand
 * out the same port twice.
 *
 * `seq` numbers the jobs, so two `open feature-x` in a row are distinguishable on a checkpoint.
 */
export type PendingJob =
	| {
			readonly kind: "open";
			readonly seq: number;
			readonly name: string;
			/** What the agent is told to do, beyond the where-you-are preface. Empty is allowed. */
			readonly prompt: string;
	  }
	| {
			readonly kind: "close";
			readonly seq: number;
			readonly name: string;
			/**
			 * Does this close pass `--force` to `git worktree remove`? `false` for every `:<id> close`
			 * and for every Close button; `true` only for `:<id> discard`, which is the one spell whose
			 * name says it loses work. See `./provision.ts`'s `teardown`.
			 */
			readonly force: boolean;
			/**
			 * The agent this close asked the kernel to end, and whose `stopped` the removal is waiting
			 * on — `null` when none was up, in which case the removal was asked for on the spot.
			 *
			 * **It is here because a close is two steps and has to be.** `stop` and the teardown cannot
			 * be answered as one list: the actor runs a cell's effects serially and a failing handler
			 * short-circuits the rest (`apps/tuval/src/host/actor.ts`), and `Processes.stop` fails
			 * `ProcessNotFound` on a process that is already gone — so an agent that crashed a moment
			 * before its `stopped` landed would take the removal down with it and leave this job set for
			 * ever, refusing every later spell "busy". Naming the process is what lets the `stopped` cell
			 * tell *this* close's ending from any other agent's, which is the whole reason a plain
			 * "something stopped" flag would not do.
			 */
			readonly stopping: ProcessId | null;
	  }
	/** Every recorded worktree, checked against disk. Queued by `resume` and by nothing else. */
	| {readonly kind: "reconcile"; readonly seq: number};

/**
 * Why an `open` was not taken. Four words, one per refusal the `open` cell makes, kept short
 * because the status line holds one of them and a sentence would not fit.
 */
export type RefusalReason = "name" | "duplicate" | "limit" | "busy";

/** One refused `open`, written down. Newest first, bounded at `REFUSAL_LIMIT`. */
export interface Refusal {
	/** The name as it was asked for, trimmed. May be empty — that is one of the refusals. */
	readonly name: string;
	readonly reason: RefusalReason;
	readonly at: number;
}

/** The refusals spelled out, for the window. The status line uses the one-word `reason` instead. */
export const REFUSAL_TEXT: Readonly<Record<RefusalReason, string>> = {
	name: "not a name a branch and a directory can both be called",
	duplicate: "a worktree of that name is already held",
	limit: "the bound on live worktrees is reached",
	busy: "something else is in flight — one provision or close at a time",
};

/**
 * A finished turn nobody could be told apart. Tuval's `Reply` is `{type, payload}` and carries no
 * process id (`Reply` in `@kampus/tuval-sdk`'s `authoring/effect.ts`), so with two agents up there is no way
 * to say whose reply this is — and guessing puts B's answer on A's row. It is kept here instead,
 * off every worktree, which is the honest place for a fact that belongs to no row.
 *
 * This is the sibling half of phoenix#9287's gap: a spawn cannot carry a cwd, and a reply cannot
 * carry a sender. When the kernel names the sender, this list stops existing.
 */
export interface UnattributedResult {
	readonly text: string;
	readonly at: number;
}

export interface WorktreeState {
	/** The repository worktrees are cut from, absolute. Env. */
	readonly repo: string;
	/** Its basename, which is what the tile's title says. Env. */
	readonly repoName: string;
	/** Where worktrees are put. Env. */
	readonly root: string;
	/** The ref a new worktree's branch starts at. Env. */
	readonly base: string;
	/** Newest first, bounded at `LIMIT`. */
	readonly worktrees: ReadonlyArray<WorktreeRecord>;
	readonly pending: PendingJob | null;
	/** Bumped for every job queued, so a dep key is never reused. */
	readonly seq: number;
	/**
	 * The worktree whose agent has been asked for and not yet announced, and the brief the `open`
	 * that started it carried. One, because a spawn is answered by exactly one `spawned` and there is
	 * no other way to tell whose child it is — and it holds the brief because by the time `spawned`
	 * lands the job that carried it is off `pending` and there is nowhere else left to read it.
	 */
	readonly spawningFor: {
		readonly name: string;
		readonly brief: string;
	} | null;
	/**
	 * The `open`s this program would not take, newest first and bounded at `REFUSAL_LIMIT`. Recorded
	 * rather than dropped: a refusal that moves no state is a button that did nothing, and "nothing
	 * happened" is the one answer a person cannot act on.
	 */
	readonly refusals: ReadonlyArray<Refusal>;
	/**
	 * Turn results that could not be attributed to a worktree, newest first and bounded at
	 * `UNATTRIBUTED_LIMIT`. See `UnattributedResult` for why this list has to exist.
	 */
	readonly unattributed: ReadonlyArray<UnattributedResult>;
}

/**
 * How many worktrees this program will hold at once. Bounded because an unbounded map in state is
 * a leak with a name — and because each one of these is a full checkout of a repository, so the
 * honest bound is far lower than the one memory would impose.
 */
export const LIMIT = 8;

/** How many refused `open`s are kept. Bounded for the reason `LIMIT` is: a log in state is a leak. */
export const REFUSAL_LIMIT = 5;

/** How many unowned turn results are kept, for the same reason. */
export const UNATTRIBUTED_LIMIT = 5;

/** A record with one more at its head, bounded. Every cell that adds a worktree agrees here. */
export const recorded = (
	worktrees: ReadonlyArray<WorktreeRecord>,
	record: WorktreeRecord,
): ReadonlyArray<WorktreeRecord> => [record, ...worktrees].slice(0, LIMIT);

/** One refusal at the head of the list, bounded. The `open` cell's four arms agree here. */
export const refused = (refusals: ReadonlyArray<Refusal>, one: Refusal): ReadonlyArray<Refusal> =>
	[one, ...refusals].slice(0, REFUSAL_LIMIT);

/** One unowned result at the head of the list, bounded. */
export const unowned = (
	results: ReadonlyArray<UnattributedResult>,
	one: UnattributedResult,
): ReadonlyArray<UnattributedResult> => [one, ...results].slice(0, UNATTRIBUTED_LIMIT);

/** The worktree under this name, or nothing. Names are unique while a record is held. */
export const byName = (state: WorktreeState, name: string): WorktreeRecord | undefined =>
	state.worktrees.find((record) => record.name === name);

/** That worktree with some fields moved, in place, leaving every other record alone. */
export const withRecord = (
	worktrees: ReadonlyArray<WorktreeRecord>,
	name: string,
	change: (record: WorktreeRecord) => WorktreeRecord,
): ReadonlyArray<WorktreeRecord> =>
	worktrees.map((record) => (record.name === name ? change(record) : record));

/** That worktree, gone from the list entirely — which is what a finished close leaves behind. */
export const without = (
	worktrees: ReadonlyArray<WorktreeRecord>,
	name: string,
): ReadonlyArray<WorktreeRecord> => worktrees.filter((record) => record.name !== name);

/**
 * A name a directory and a branch can both be called. Refused where it is typed rather than at
 * `git worktree add`, because `git`'s refusal names a path the person never wrote.
 */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

/** Is this worktree one the program still considers live — that is, not closable twice? */
export const isLive = (record: WorktreeRecord): boolean =>
	record.status === "provisioning" || record.status === "open" || record.status === "closing";

/** The ports this state has already handed out, which a probe must skip on top of the OS's. */
export const takenPorts = (state: WorktreeState): ReadonlyArray<number> =>
	state.worktrees.flatMap((record) =>
		record.port === null || !isLive(record) ? [] : [record.port],
	);

/**
 * The status line, in one place. The row's `status` derives its self-report from this and the
 * window draws the same sentence, so a tile and a window never disagree.
 *
 * `2 open · feature-x :5174 running` — the count first, because that is the number a person glances
 * for, and then the newest live worktree spelled out, because one line can hold exactly one.
 *
 * Two clauses may follow it, and they are there because the alternative is silence: a refused
 * `open` and a turn result nobody could be told apart are both things that happened, and a tile
 * that does not say so is a tile that lies by omission.
 */
export const statusLine = (state: WorktreeState): string =>
	`${liveLine(state)}${refusalClause(state)}${unattributedClause(state)}`;

const liveLine = (state: WorktreeState): string => {
	const open = state.worktrees.filter((record) => record.status === "open").length;
	const head = `${open} open`;
	const busy = state.pending;
	if (busy !== null) {
		return busy.kind === "reconcile"
			? `${head} · reconciling`
			: `${head} · ${busy.kind === "open" ? "provisioning" : "closing"} ${busy.name}`;
	}
	const newest = state.worktrees.find(isLive);
	if (newest === undefined) return `${head} · nothing open`;
	const port = newest.port === null ? "" : ` :${newest.port}`;
	return `${head} · ${newest.name}${port} ${agentWord(newest)}`;
};

/** The newest refusal, in the one word it has. Empty when none has been made. */
const refusalClause = (state: WorktreeState): string => {
	const newest = state.refusals[0];
	if (newest === undefined) return "";
	const which = newest.name === "" ? "(unnamed)" : newest.name;
	return ` · refused ${which}: ${newest.reason}`;
};

/** How many replies could not be told apart. Empty when every one of them could. */
const unattributedClause = (state: WorktreeState): string =>
	state.unattributed.length === 0 ? "" : ` · ${state.unattributed.length} unattributed`;

/** What one worktree's agent is doing, in the one word a status line can hold. */
const agentWord = (record: WorktreeRecord): string => {
	if (record.status === "gone") return "gone";
	if (record.status === "failed") return "failed";
	return record.agent === null ? "idle" : "running";
};

/**
 * The predicate a renderer table admits this program's state through (ADR 0358). It is exported as
 * `admits` from `./window.tsx`, which is the export the page's module loader reads.
 *
 * It checks the fields the window draws and their types, and nothing beyond them: a kernel one
 * commit older than the page sends a record missing a field, and the honest answer to that is the
 * window's own refusal placeholder rather than a throw inside React.
 */
export const isWorktreeState = (state: unknown): state is WorktreeState => {
	if (typeof state !== "object" || state === null) return false;
	const candidate = state as Record<string, unknown>;
	return (
		typeof candidate.repo === "string" &&
		typeof candidate.repoName === "string" &&
		typeof candidate.root === "string" &&
		typeof candidate.base === "string" &&
		typeof candidate.seq === "number" &&
		(candidate.spawningFor === null || typeof candidate.spawningFor === "object") &&
		Array.isArray(candidate.refusals) &&
		candidate.refusals.every(isRefusal) &&
		Array.isArray(candidate.unattributed) &&
		candidate.unattributed.every(isUnattributed) &&
		Array.isArray(candidate.worktrees) &&
		candidate.worktrees.every(isWorktreeRecord)
	);
};

const REASONS: ReadonlyArray<string> = ["name", "duplicate", "limit", "busy"];

const isRefusal = (refusal: unknown): refusal is Refusal => {
	if (typeof refusal !== "object" || refusal === null) return false;
	const candidate = refusal as Record<string, unknown>;
	return (
		typeof candidate.name === "string" &&
		typeof candidate.reason === "string" &&
		REASONS.includes(candidate.reason) &&
		typeof candidate.at === "number"
	);
};

const isUnattributed = (result: unknown): result is UnattributedResult => {
	if (typeof result !== "object" || result === null) return false;
	const candidate = result as Record<string, unknown>;
	return typeof candidate.text === "string" && typeof candidate.at === "number";
};

const STATUSES: ReadonlyArray<string> = ["provisioning", "open", "closing", "failed", "gone"];

const isWorktreeRecord = (record: unknown): record is WorktreeRecord => {
	if (typeof record !== "object" || record === null) return false;
	const candidate = record as Record<string, unknown>;
	return (
		typeof candidate.name === "string" &&
		typeof candidate.path === "string" &&
		typeof candidate.branch === "string" &&
		(candidate.port === null || typeof candidate.port === "number") &&
		typeof candidate.status === "string" &&
		STATUSES.includes(candidate.status) &&
		(candidate.agent === null || typeof candidate.agent === "string") &&
		(candidate.detail === null || typeof candidate.detail === "string") &&
		typeof candidate.openedAt === "number"
	);
};

// -- The window's view of all that ------------------------------------------

/** One worktree as the window lists it: the inputs it was given, resolved. */
export interface WorktreeRowView {
	readonly key: string;
	readonly name: string;
	readonly path: string;
	readonly branch: string;
	/** `:5174`, or an em dash while there is no port yet. */
	readonly port: string;
	readonly status: WorktreeStatus;
	/** `running`, `idle`, `gone`, `failed` — the same word the status line uses. */
	readonly agent: string;
	readonly detail: string | null;
	/** May this row be closed right now? A closing one may not, and neither may a busy program. */
	readonly closable: boolean;
}

/** One refused `open`, as the window spells it out. */
export interface RefusalView {
	readonly key: string;
	readonly name: string;
	/** The whole sentence, out of `REFUSAL_TEXT` — the window has room the status line does not. */
	readonly text: string;
}

/** One reply that belonged to no row, as the window shows it. */
export interface UnattributedView {
	readonly key: string;
	readonly text: string;
}

/**
 * Everything the window draws, as data. Pure, so the mapping is a unit test rather than a render
 * test: what a window shows is decided here and React only puts it on the screen.
 */
export interface WorktreeWindowView {
	/** The heading: which repository these worktrees are cut from. */
	readonly repoName: string;
	readonly repo: string;
	readonly root: string;
	readonly base: string;
	/** The same sentence the tile carries. */
	readonly status: string;
	/** Is a provision or a close in flight? Every control is disabled while one is. */
	readonly busy: boolean;
	readonly rows: ReadonlyArray<WorktreeRowView>;
	/** May another worktree be opened, or is the bound reached? */
	readonly canOpen: boolean;
	/** What to say where the list would be, when there is none. */
	readonly empty: string;
	/** The `open`s this program would not take, newest first. */
	readonly refusals: ReadonlyArray<RefusalView>;
	/** The replies that belonged to no row, newest first. */
	readonly unattributed: ReadonlyArray<UnattributedView>;
	/** The one line that says why this list exists at all. Empty when it is empty. */
	readonly unattributedNote: string;
}

/** The whole of the window's reading of a worktree program. */
export const worktreeView = (state: WorktreeState): WorktreeWindowView => {
	const busy = state.pending !== null;
	return {
		repoName: state.repoName,
		repo: state.repo,
		root: state.root,
		base: state.base,
		status: statusLine(state),
		busy,
		canOpen: !busy && state.worktrees.filter(isLive).length < LIMIT,
		rows: state.worktrees.map((record) => ({
			key: `${record.name}-${record.openedAt}`,
			name: record.name,
			path: record.path,
			branch: record.branch,
			port: record.port === null ? "—" : `:${record.port}`,
			status: record.status,
			agent: agentWord(record),
			detail: record.detail,
			closable: !busy && record.status !== "closing",
		})),
		empty: busy
			? "Nothing open yet — the first one is still being provisioned."
			: "Nothing open. `:worktree open <name>` provisions one.",
		refusals: state.refusals.map((refusal, index) => ({
			key: `${refusal.at}-${index}`,
			name: refusal.name === "" ? "(unnamed)" : refusal.name,
			text: REFUSAL_TEXT[refusal.reason],
		})),
		unattributed: state.unattributed.map((result, index) => ({
			key: `${result.at}-${index}`,
			text: result.text,
		})),
		unattributedNote:
			state.unattributed.length === 0
				? ""
				: "More than one agent was running when these came back, and a reply carries no sender — so they are kept here rather than guessed onto a row (phoenix#9287's sibling gap).",
	};
};

/**
 * The events the window's controls send: the same arrivals `:worktree open` and
 * `:worktree close` put on the two in-ports, because a window and a spell asking for the same
 * thing must reach the same cell.
 */
// `type` and not `interface`, deliberately: only an alias gets TypeScript's implicit index
// signature, and without one this shape is not assignable to Tuval's `Message` — which is what
// `WindowHost.dispatch` is typed at.
export type WorktreeCommandEvent =
	| {readonly type: "open"; readonly payload: {readonly name: string}}
	| {readonly type: "close"; readonly payload: {readonly name: string}}
	| {readonly type: "discard"; readonly payload: {readonly name: string}};

/** Those events, built. Functions rather than constants so no caller holds a shared object. */
export const openEvent = (name: string): WorktreeCommandEvent => ({
	type: "open",
	payload: {name},
});

/**
 * The close that does not lose work. It reaches `git worktree remove` with **no** `--force`, so a
 * worktree with uncommitted changes in it refuses the removal and says so. This is what the Close
 * button sends, and there is no variant of it that forces.
 */
export const closeEvent = (name: string): WorktreeCommandEvent => ({
	type: "close",
	payload: {name},
});

/**
 * The close that does lose work — `git worktree remove --force`, which throws away uncommitted
 * changes. A separate event with a separate name for the reason it is a separate spell: "discard"
 * says what happens and "close --force" does not.
 */
export const discardEvent = (name: string): WorktreeCommandEvent => ({
	type: "discard",
	payload: {name},
});
