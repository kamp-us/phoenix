/**
 * The shell as one ordinary program row (#7558). There is no built-in shell: the desk is a
 * `Program` like the demo counter is, registered through the user-owned config module, spawned by
 * the graph as a root process, and checkpointed by the kernel's own durability. Nothing here opens
 * a store, and nothing under `src/shell/` may — the shell's desk comes back because
 * `src/durability/` brings every process back, not because the shell saves itself (#7514).
 *
 * Three things this module is deliberately not. It is not a second persistence path: the state it
 * hands the kernel is the core's JSON and the kernel writes it. It is not a spawn path: `shellNode`
 * is a graph node like any other, so "boot spawns the shell exactly once" is the graph's one node,
 * not a guard in code. And it is not the shell's runtime: the core's four Cmds are handed to
 * whoever runs the desk, and this slice ships only the inert set (`unwiredShellEffects`).
 */

import {Effect} from "effect";
import type {GraphNode} from "../ports/graph.ts";
import {NodeId} from "../ports/graph.ts";
import {ProcessId} from "../process/process.ts";
import type {AnyProgram, HostHandlers, Program} from "../registry/program.ts";
import {ProgramId} from "../registry/program.ts";
import {shellSpells, shellSpellsFor} from "./commands/spells.ts";
import {commandIndexFor, type ShellCommandFeatures} from "./commands/table.ts";
import {
	isShellState,
	type ShellCmd,
	type ShellMsg,
	type ShellState,
	shellCore,
} from "./core/index.ts";
import {defaultPrefixTable, type PrefixTable, prefixTableFor} from "./keys/index.ts";
import {windows} from "./layout/index.ts";
import {type Empty, empty, type ProcessGone, processGone, WindowId} from "./window/index.ts";

/** The row's stable id. A founder rebinding the shell in their own config replaces this id's row. */
export const shellId = ProgramId.make("shell");

/**
 * The graph node boot plans, and so the id the shell's process is spawned and checkpointed under
 * (`launch` spawns each node at its own id). A stable id is what makes the second boot a restore.
 */
export const shellNode = NodeId.make("shell");

/**
 * The definition version a snapshot is checked against. Bumping it refuses every desk saved under
 * the old one rather than replaying it into a changed state shape (#7467).
 */
export const SHELL_VERSION = "1.2.0";

/**
 * What the core asks its host to do, as the kernel's own handler shape. `E` and `R` ride through to
 * the row, so a later surface may hand in effects that need `Processes` or a transport without this
 * module knowing either.
 */
export type ShellEffects<E = never, R = never> = HostHandlers<ShellMsg, ShellCmd, E, R>;

/**
 * The only effects this slice ships: none of the four do anything. That is honest rather than
 * convenient — forwarding a key needs the transport (#7556 wires it) and the repeat timer needs a
 * host that can dispatch back later, which a kernel handler cannot do (it returns its follow-ups,
 * it does not hold a dispatcher). Until the surface lands (#7557, #7559) a desk booted with these
 * splits and focuses through direct Msgs and answers no key. Each drop is logged at debug so the
 * silence is visible to anyone who goes looking, and quiet for everyone who does not.
 */
export const unwiredShellEffects: ShellEffects = {
	forwardKey: (cmd) =>
		Effect.logDebug(`shell: forwardKey "${cmd.key}" dropped — no surface attached`).pipe(
			Effect.as([]),
		),
	startRepeatTimer: (cmd) =>
		Effect.logDebug(
			`shell: startRepeatTimer ${cmd.timeoutMs}ms dropped — no surface attached`,
		).pipe(Effect.as([])),
	cancelRepeatTimer: () =>
		Effect.logDebug("shell: cancelRepeatTimer dropped — no surface attached").pipe(Effect.as([])),
	runCommand: (cmd) =>
		Effect.logDebug(`shell: runCommand "${cmd.name}" names no command row — dropped`).pipe(
			Effect.as([]),
		),
	openProgram: (cmd) =>
		Effect.logDebug(
			`shell: openProgram "${cmd.programId}" dropped — no surface attached to spawn it`,
		).pipe(Effect.as([])),
	attachProcess: (cmd) =>
		Effect.logDebug(
			`shell: attachProcess "${cmd.processId}" dropped — no surface attached to resolve it`,
		).pipe(Effect.as([])),
	openCommandLine: () =>
		Effect.logDebug("shell: openCommandLine dropped — no surface attached").pipe(Effect.as([])),
	reloadConfig: () =>
		Effect.logDebug("shell: reloadConfig dropped — no config loader attached").pipe(Effect.as([])),
};

export interface ShellProgramOptions<E = never, R = never> {
	/**
	 * The key grammar the core routes against. Configuration, never state — it holds `Duration`s.
	 * Absent means `defaultPrefixTable`.
	 */
	readonly table?: PrefixTable;
	/** What runs the core's Cmds. Required: an absent set would be an inert desk nobody chose. */
	readonly effects: ShellEffects<E, R>;
}

/**
 * The one place on the boot path that names `defaultPrefixTable`. Both readers go through it — the
 * row resolving its own option, and `shellPrefixTable` reading a config's rows back — so the value
 * the kernel routes over and the value the transport sends cannot be two different tables (#7890,
 * the open consequence ADR 0353 left).
 */
const resolveTable = (table: PrefixTable | undefined): PrefixTable => table ?? defaultPrefixTable;

/** The shell's row, publishing the grammar it resolved so a later reader need not re-derive it. */
export interface ShellRow extends AnyProgram {
	readonly table: PrefixTable;
}

/**
 * The shell's registry row. No public ports and no capability requests: nothing addresses the shell
 * over a port, and the #7467 records ride along as the inert data every row carries.
 *
 * No `renderer` either, which makes the row headless: the shell *is* the desk, mounted by the page
 * off its own process (`src/page/main.tsx`), never a window inside itself. A declared renderer put
 * the row in both picker lists and bound a window to a name the page's table cannot resolve
 * (#7946).
 *
 * `spells` is the command table (`./commands/`), so every named row is registered under
 * `[shellId, ...path]` and reachable through the one registry — the palette, `help`, and an agent's
 * bridge all read the shell's commands there rather than from a second catalogue. Running one needs
 * `ShellDispatch`, which `AnySpell` erases; `src/boot.ts` owes it and pays it with
 * `shellDispatchKernel(shellId)`, which finds this row's live process and dispatches into it.
 *
 * `table` is the resolved grammar, on the row rather than only closed into the core: the transport
 * is started from `src/bin.ts`, which holds the kernel and not the config, so without a value it
 * could read back it had to name a default of its own (#7890).
 */
export const shellProgram = <E = never, R = never>({
	table,
	effects,
}: ShellProgramOptions<E, R>): ShellRow => {
	const resolved = resolveTable(table);
	return {
		id: shellId,
		table: resolved,
		core: shellCore({table: resolved}),
		ports: {},
		spells: shellSpells,
		handlers: effects,
		capabilities: [],
		identity: {
			package: "@kampus/tuval",
			program: "shell",
			version: SHELL_VERSION,
			digest: "sha256:shell",
		},
		// The kernel's word for the Node host is `local` (`src/registry/program.ts`); the shell runs
		// where the kernel runs, and a browser-placed shell is not a thing this slice can spawn.
		placement: {host: "local"},
	} satisfies Program<ShellState, ShellMsg, ShellCmd, never, unknown, E, R> & {
		readonly table: PrefixTable;
	};
};

/**
 * A config's rows carry whatever they were built with, and `Registry` erases none of it. Config
 * rows are trusted local code (#7484 R1.1) — the loader checks a row's id, not its shape — so the
 * id plus a published table is the whole test.
 */
const isShellRow = (program: AnyProgram): program is ShellRow =>
	program.id === shellId && "table" in program;

/**
 * The rows a boot's merged feature flags leave standing. A config module is evaluated before the
 * merge exists (#8595), so the shell's row is built flag-blind and this is the one seam that knows
 * both: `boot` calls it once, and everything downstream — the registry, the spell set, the grammar
 * the transport sends — reads the gated row rather than re-deriving the gate for itself (#8867).
 *
 * Gating is additive and lives in two lists, `boardBindings` in `./keys/table.ts` and
 * `boardCommands` in `./commands/table.ts`. Both are keyed on the one flag, so a key can never name
 * a row this build does not hold.
 */
export const withShellFeatures = (
	programs: ReadonlyArray<AnyProgram>,
	features: ShellCommandFeatures,
): ReadonlyArray<AnyProgram> =>
	programs.map((program) => {
		if (!isShellRow(program)) return program;
		const table = prefixTableFor(program.table, features);
		const commands = commandIndexFor(features);
		return {
			...program,
			table,
			core: shellCore({table, commands}),
			spells: shellSpellsFor(features),
		} satisfies ShellRow;
	});

/**
 * The key grammar a config's rows put the kernel on: the shell row's resolved table, or the same
 * default that row would have taken when the config registers no shell at all (a kernel with no
 * desk still serves a socket, and the grammar it sends a page is that default).
 *
 * `boot` reports this as `Booted.keyTable` and `src/bin.ts` hands that to `serveDesk`, which is
 * what leaves the shell row the single namer of the kernel's grammar (#7890).
 */
export const shellPrefixTable = (programs: ReadonlyArray<AnyProgram>): PrefixTable =>
	resolveTable(programs.find(isShellRow)?.table);

/**
 * The shell's node: a root — no `parent` — with no routes, because it speaks over no port. A config
 * module spreads this into its own graph, so a founder can drop the shell by dropping the node.
 */
export const shellGraphNode: GraphNode = {id: shellNode, program: shellId, on: []};

/** What a restored window's process id resolved to. */
export type RestoredBinding =
	/** The process is still in the table. The window's renderer mounts over it as before. */
	{readonly _tag: "Live"; readonly processId: ProcessId} | ProcessGone | Empty;

/**
 * A checkpointed desk, or `null`. The kernel erases every program's state to `unknown`
 * (`ProcessRow.stateSummary`), so this is the trust boundary a snapshot re-enters through
 * (`.patterns/effect-schema-validation.md` names persisted JSON as exactly that) — and the check is
 * `isShellState`, which is total over the state, so no cast stands between the answer and the type.
 * A version-matched snapshot with a corrupt workspace, view or order entry is refused here.
 */
export const shellStateOf = (state: unknown): ShellState | null =>
	isShellState(state) ? state : null;

/**
 * Every window of every restored workspace, against the processes the kernel actually brought back.
 * A window whose process id no longer resolves is **kept**, pointing at `ProcessGone`: the desk a
 * founder left is theirs, and a dead process is a placeholder in a window, never a window that
 * silently disappeared (#7484 R1.1, the Vim buffer model — a window is a view, not a container).
 *
 * This is the seam #7700 named: the layout tree's ids are plain strings, because that module is
 * kept free of Effect (#7551), and the window contract's are `Schema.brand`ed (#7553). One
 * conversion, here, through the brand's own constructor — no `as WindowId` anywhere.
 */
export const windowBindings = (
	state: ShellState,
	live: ReadonlySet<ProcessId>,
): ReadonlyMap<WindowId, RestoredBinding> => {
	const bindings = new Map<WindowId, RestoredBinding>();
	for (const workspaceId of state.order) {
		const workspace = state.workspaces[workspaceId];
		if (workspace === undefined) continue;
		for (const window of windows(workspace.layout.root)) {
			const windowId = WindowId.make(window.id);
			if (window.processId === null) {
				bindings.set(windowId, empty);
				continue;
			}
			const processId = ProcessId.make(window.processId);
			bindings.set(
				windowId,
				live.has(processId) ? {_tag: "Live", processId} : processGone(processId),
			);
		}
	}
	return bindings;
};
