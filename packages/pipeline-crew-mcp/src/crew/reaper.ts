/**
 * crew/reaper — reap ORPHANED crew server processes: the process-table half of crash recovery.
 *
 * tracker/server.ts's `reclaimStaleSocket` cleans a crashed host's stale *socket file*; it does
 * nothing about the crashed session's *process*. When a crew pane dies (crash, re-run, tmux kill),
 * its `node … bin.ts session --role <role>` server child is reparented to init (PPID 1) and keeps
 * running — the live diagnosis in epic #3624 found 4 day-old such orphans in the process table
 * (failure mode 3). This module is the missing reap: it identifies crew session server procs that are
 * no longer a live registered channel half and terminates them, so a crashed/re-run session leaves no
 * zombie peer (#3629). It complements — never replaces — the socket-file reclaim.
 *
 * The orphan signal is REPARENTING TO INIT (`ppid === INIT_PID`): a live session's server is a child
 * of its living launch pane, so `ppid === 1` is exactly "the pane that owned me is gone." That signal
 * alone never touches a live registered session, which is parented. The canonical registry (ADR 0197)
 * is consulted as the extra guard for the one case it can resolve: an ENGINE instance's per-instance
 * address is unique, so a reparented engine whose exact address still holds a live presence lease is
 * still serving and is spared (it reaps on a later pass once its lease ages out). A BRIDGE address is
 * shared across re-runs, so it can't disambiguate a superseded orphan from its live successor — a
 * reparented bridge server therefore reaps on the ppid signal alone, which is what actually clears the
 * day-old bridge orphans the diagnosis found.
 *
 * Every side-effecting seam (the process snapshot, the kill, the live-registered address set) is
 * injected and defaults to production, so orphan-vs-live discrimination is unit-tested against a
 * fixture with no real process, `ps`, or signal — the injected-seam idiom the rest of the substrate uses.
 */
import {execFileSync} from "node:child_process";
import {Effect, Schema} from "effect";
import {CREW_ROLES, type CrewRole, isCrewRole, kindOf} from "./roles.ts";
import {inboxAddressFor} from "./session.ts";

/** The pid every orphaned (reparented) process is adopted by — init/launchd is PID 1 on macOS and Linux alike. */
export const INIT_PID = 1;

/** The package-path marker present in every crew session server command (`… /pipeline-crew-mcp/… /bin.ts …`). */
const CREW_MCP_MARKER = "pipeline-crew-mcp";
/** The bin subcommand that runs one live crew session — mirrors bind.ts's `CREW_SESSION_COMMAND`. */
const CREW_SESSION_SUBCOMMAND = "session";

/** One row of the process table: a pid, its parent pid, and the full command (argv) it runs. */
export interface ProcessEntry {
	readonly pid: number;
	readonly ppid: number;
	readonly command: string;
}

/** A crew session server proc's identity, parsed out of its `session --role <role> [--instance <id>]` argv. */
export interface CrewSessionProc {
	readonly role: CrewRole;
	readonly instance: string | undefined;
}

/** Read a `--flag value` argument from a command string (bind.ts renders each as adjacent whitespace-separated tokens). */
const flagValue = (command: string, flag: string): string | undefined => {
	const match = command.match(new RegExp(`(?:^|\\s)${flag}[=\\s]+(\\S+)`));
	return match?.[1];
};

/**
 * Parse a process command into a crew session proc identity, or `undefined` when it is not one.
 * Tightly scoped so an unrelated process is never matched: the command must carry the crew-mcp bin
 * marker AND the `session` subcommand AND a `--role` naming an actual `CREW_ROLE`. A decoy `--role` on
 * some other tool, a `session` of some other program, or a `--role <not-a-crew-role>` all resolve to
 * `undefined` — the "without touching unrelated processes" scope guarantee.
 */
export const parseCrewSessionProc = (command: string): CrewSessionProc | undefined => {
	if (!command.includes(CREW_MCP_MARKER)) return undefined;
	if (!new RegExp(`(?:^|\\s)${CREW_SESSION_SUBCOMMAND}(?:\\s|$)`).test(command)) return undefined;
	const role = flagValue(command, "--role");
	if (role === undefined || !isCrewRole(role)) return undefined;
	return {role, instance: flagValue(command, "--instance")};
};

/** The inputs orphan discrimination reads: this reaper's own pid (never reap self) and the live-registered address set. */
export interface OrphanDiscriminationInput {
	readonly selfPid: number;
	readonly liveRegisteredAddresses: ReadonlySet<string>;
}

/**
 * Is `entry` an orphaned crew server proc that should be reaped? True iff it is a crew session server
 * (`parseCrewSessionProc`), it is not this process, it is reparented to init (`ppid === INIT_PID`), and
 * it is not still a live registered engine instance. So a live registered session — parented, hence
 * `ppid !== INIT_PID` — is never reaped, and neither is a reparented engine instance whose exact
 * per-instance address still holds a live lease.
 */
export const isOrphanedCrewServer = (
	entry: ProcessEntry,
	{selfPid, liveRegisteredAddresses}: OrphanDiscriminationInput,
): boolean => {
	const proc = parseCrewSessionProc(entry.command);
	if (proc === undefined) return false;
	if (entry.pid === selfPid) return false;
	if (entry.ppid !== INIT_PID) return false;
	// The one registry-resolvable spare: a reparented ENGINE whose unique per-instance address still
	// holds a live lease is actively serving — leave it, it reaps once the lease ages out. A bridge's
	// shared address can't tell a superseded orphan from its live successor, so it reaps on ppid alone.
	if (
		proc.instance !== undefined &&
		kindOf(proc.role) === "engine" &&
		liveRegisteredAddresses.has(inboxAddressFor(proc.role, proc.instance))
	) {
		return false;
	}
	return true;
};

/** A process snapshot failed to read the OS process table — surfaced, never silently treated as "no orphans". */
export class ProcessSnapshotError extends Schema.TaggedErrorClass<ProcessSnapshotError>()(
	"@kampus/pipeline-crew-mcp/crew/ProcessSnapshotError",
	{reason: Schema.String},
) {}

/** Enumerate the OS process table. Injected so the reaper is driven against a fixture with no real `ps`. */
export interface ProcessSnapshot {
	readonly list: Effect.Effect<ReadonlyArray<ProcessEntry>, ProcessSnapshotError>;
}

/** Whether a kill signal landed on a live process, or the process was already gone (idempotent re-reap). */
export type ReapSignalOutcome = "signalled" | "already-gone";

/** Terminate a process by pid. Injected so the reaper is driven with no real signal; production sends `REAP_SIGNAL`. */
export interface ProcessReaper {
	readonly kill: (pid: number) => Effect.Effect<ReapSignalOutcome>;
}

/**
 * Read the process table via `ps -A -o pid=,ppid=,args=` — pid, ppid, and full argv per row, headers
 * suppressed by the `=` suffixes. The `pid=,ppid=,args=` field set is portable across BSD (macOS) and
 * GNU (Linux) `ps`.
 */
export const productionProcessSnapshot: ProcessSnapshot = {
	list: Effect.try({
		try: () =>
			execFileSync("ps", ["-A", "-o", "pid=,ppid=,args="], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}),
		catch: (cause) => new ProcessSnapshotError({reason: `ps -A failed: ${String(cause)}`}),
	}).pipe(Effect.map(parseProcessTable)),
};

/** Parse `ps -o pid=,ppid=,args=` output: each non-empty line is `<pid> <ppid> <args…>`. Unparseable lines are skipped. */
export function parseProcessTable(output: string): ReadonlyArray<ProcessEntry> {
	const entries: ProcessEntry[] = [];
	for (const line of output.split("\n")) {
		const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
		if (match === null) continue;
		const [, pidStr, ppidStr, command] = match;
		if (pidStr === undefined || ppidStr === undefined || command === undefined) continue;
		const pid = Number(pidStr);
		const ppid = Number(ppidStr);
		if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
		entries.push({pid, ppid, command: command.trim()});
	}
	return entries;
}

/** The reap signal: `SIGTERM`, so a reaped orphan runs its scope teardown (unlinking its own inbox socket) rather than being hard-killed. */
export const REAP_SIGNAL = "SIGTERM";

/**
 * Terminate via `process.kill(pid, SIGTERM)`. `ESRCH` (no such process) is the idempotent case — the
 * orphan is already gone — reported as `already-gone`, never an error. A non-`ESRCH` fault (e.g. a
 * permission `EPERM`) is folded to `already-gone` too, so one un-killable pid never aborts the sweep.
 */
export const productionProcessReaper: ProcessReaper = {
	kill: (pid) =>
		Effect.try({
			try: (): ReapSignalOutcome => {
				process.kill(pid, REAP_SIGNAL);
				return "signalled";
			},
			// Type the error channel (the effect `unknownInEffectCatch` lint) — the value is unused, it
			// is immediately folded to `already-gone` below, so any typed rendering serves; `String`
			// matches the package's `Effect.try` catch idiom.
			catch: (cause) => String(cause),
		}).pipe(Effect.orElseSucceed((): ReapSignalOutcome => "already-gone")),
};

/** The per-orphan result of a reap sweep: which crew server proc it was and whether the signal landed. */
export interface ReapOutcome {
	readonly pid: number;
	readonly role: CrewRole;
	readonly instance: string | undefined;
	readonly outcome: ReapSignalOutcome;
}

/** The result of one reap sweep: what was reaped, how many procs were scanned, and the live halves left untouched. */
export interface ReapReport {
	readonly reaped: ReadonlyArray<ReapOutcome>;
	/** How many processes the snapshot scanned — the discrimination denominator (observability). */
	readonly scanned: number;
	/** The live registered addresses left untouched — the operator picture the doctor (#3630) composes. */
	readonly liveRegistered: ReadonlyArray<string>;
}

/** What one reap sweep needs: the live-registered address set, plus injectable seams defaulting to production. */
export interface ReapOrphansInput {
	readonly liveRegisteredAddresses: ReadonlySet<string>;
	readonly snapshot?: ProcessSnapshot;
	readonly reaper?: ProcessReaper;
	readonly selfPid?: number;
}

/**
 * Reap every orphaned crew server proc in the current process table (keyed off the canonical registry's
 * live-registered set): snapshot the table, discriminate orphans (`isOrphanedCrewServer`), signal each,
 * and report. Idempotent — a re-run finds the already-reaped procs gone from the next snapshot (or their
 * kill resolves `already-gone`), so it is safe to run repeatedly and on every stand-up.
 */
export const reapOrphanedCrewServers = (
	input: ReapOrphansInput,
): Effect.Effect<ReapReport, ProcessSnapshotError> =>
	Effect.gen(function* () {
		const snapshot = input.snapshot ?? productionProcessSnapshot;
		const reaper = input.reaper ?? productionProcessReaper;
		const selfPid = input.selfPid ?? process.pid;
		const {liveRegisteredAddresses} = input;

		const entries = yield* snapshot.list;
		const orphans = entries.flatMap((entry) => {
			if (!isOrphanedCrewServer(entry, {selfPid, liveRegisteredAddresses})) return [];
			const proc = parseCrewSessionProc(entry.command);
			return proc === undefined ? [] : [{entry, proc}];
		});

		const reaped: ReapOutcome[] = [];
		for (const {entry, proc} of orphans) {
			const outcome = yield* reaper.kill(entry.pid);
			reaped.push({pid: entry.pid, role: proc.role, instance: proc.instance, outcome});
		}

		return {
			reaped,
			scanned: entries.length,
			liveRegistered: [...liveRegisteredAddresses].sort(),
		};
	});

/**
 * Collect the inbox addresses currently holding a live presence lease, unioned across the whole roster —
 * the "live registered channel half" set the reaper keys its engine-spare guard on. `lookup` is the
 * registry's role → present-peers reader (tracker/registry.ts `Registry.lookup`, or a client of it),
 * whose result reflects attached-inbox liveness (#3628); injected so this composes with either the
 * in-process registry or a dialed tracker client, and is unit-testable against a fixture map.
 */
export const collectLiveRegisteredAddresses = (
	lookup: (role: CrewRole) => Effect.Effect<ReadonlyArray<{readonly peer: string}>>,
): Effect.Effect<ReadonlySet<string>> =>
	Effect.gen(function* () {
		const addresses = new Set<string>();
		for (const role of CREW_ROLES) {
			const present = yield* lookup(role);
			for (const record of present) addresses.add(record.peer);
		}
		return addresses;
	});
