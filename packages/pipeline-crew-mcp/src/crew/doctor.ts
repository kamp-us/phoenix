/**
 * crew/doctor — one command to SEE and FIX crew channel health in a single gesture (#3630).
 *
 * The reachability surface for the whole crew rewrite: it composes the three separately-built signals
 * into one operator picture over the canonical rendezvous (#C2), classifying every roster role as
 *   - REGISTERED — an attached channel half is live (`tracker` `lookup` returns it, #3628),
 *   - CHANNEL-DEAF — its launch pane is up (a live, PARENTED `session --role` server proc) yet no
 *     attached channel half is registered (#C3): "up in tmux but every send fails,"
 *   - ABSENT — no live pane and no registration,
 * and separately naming the ORPHANED crew server procs (reparented to init, #C4) the reaper reaps.
 *
 * It REUSES the merged parts, never reimplements them: `parseCrewSessionProc` + `isOrphanedCrewServer`
 * (crew/reaper.ts, #3629) are the exact orphan discrimination `--reap` will act on, so the report is
 * truthful about what a reap terminates; the live-registered set rides `CrewTracker.lookup`'s
 * attached-inbox liveness (#3628). Channel-deaf is the one signal this module adds: a parented crew
 * proc whose inbox address is not in the attached set — the reaper deliberately spares it (it is not an
 * orphan), so it would otherwise go unseen. The fix it points at is re-seat via `retire-role` →
 * `spawn-role` (#3576).
 *
 * The pure classifier (`classifyCrewChannelHealth`) takes a process snapshot + the live-registered set
 * and returns the report — no IO, so the registered/deaf/orphaned discrimination is unit-tested against
 * a mixed fixture with no real process, `ps`, tracker, or signal. Every side-effecting seam (the
 * snapshot, the reaper, the tracker dial) is injected and defaults to production, the same idiom the
 * reaper and the orchestration use.
 */
import {Effect} from "effect";
import {resolveRendezvous} from "../tracker/index.ts";
import {
	type CrewSessionProc,
	collectLiveRegisteredAddresses,
	INIT_PID,
	isOrphanedCrewServer,
	type ProcessEntry,
	type ProcessReaper,
	type ProcessSnapshot,
	type ProcessSnapshotError,
	parseCrewSessionProc,
	productionProcessSnapshot,
	type ReapReport,
	reapOrphanedCrewServers,
} from "./reaper.ts";
import {CREW_ROLES, type CrewRole, isCrewRole, kindOf} from "./roles.ts";
import {inboxAddressFor} from "./session.ts";
import {CrewTracker, crewTrackerSocketLayer} from "./tracker.ts";

/** A role's channel health over the rendezvous: reachable, up-but-deaf, or not present. */
export type ChannelHealthStatus = "registered" | "channel-deaf" | "absent";

/** A parented crew server proc with no attached channel half — its pane is up but every send to it fails (#C3). */
export interface DeafProc {
	readonly pid: number;
	readonly role: CrewRole;
	readonly instance: string | undefined;
}

/** An orphaned (reparented-to-init) crew server proc the reaper would reap (#C4). */
export interface OrphanedProc {
	readonly pid: number;
	readonly role: CrewRole;
	readonly instance: string | undefined;
}

/** One role's health row: its status, its live attached inbox addresses, and any channel-deaf panes it has. */
export interface RoleChannelHealth {
	readonly role: CrewRole;
	readonly status: ChannelHealthStatus;
	readonly registered: ReadonlyArray<string>;
	readonly deaf: ReadonlyArray<DeafProc>;
}

/** The whole crew's channel picture: per-role health, the reapable orphans, and the scan denominator. */
export interface CrewChannelHealthReport {
	readonly roles: ReadonlyArray<RoleChannelHealth>;
	readonly orphaned: ReadonlyArray<OrphanedProc>;
	/** How many processes the snapshot scanned — the discrimination denominator (observability). */
	readonly scanned: number;
}

/** What the pure classifier reads: the process table, the live-registered (attached) address set, and self. */
export interface CrewChannelHealthInput {
	readonly processes: ReadonlyArray<ProcessEntry>;
	readonly liveRegisteredAddresses: ReadonlySet<string>;
	readonly selfPid: number;
}

/**
 * The crew role an `inbox://<role>` or `inbox://<role>/<instance>` address serves, or `undefined` when
 * it is not a dialable crew inbox — the read-side inverse of `inboxAddressFor`, used to bucket the
 * registry's attached addresses by role without needing the proc that serves each.
 */
export const roleOfInboxAddress = (address: string): CrewRole | undefined => {
	const match = address.match(/^inbox:\/\/([^/]+)(?:\/.*)?$/);
	const role = match?.[1];
	return role !== undefined && isCrewRole(role) ? role : undefined;
};

/**
 * The dialable inbox address a parsed crew proc serves, or `undefined` when it can't be pinned down —
 * an engine whose argv carries no `--instance` (a direct run that minted its id at runtime) can't be
 * matched against the registry, so it resolves `undefined` and is never mistaken for registered. A
 * bridge folds no instance into its address (`inbox://<role>`), so it always resolves.
 */
export const crewProcInboxAddress = (proc: CrewSessionProc): string | undefined => {
	if (kindOf(proc.role) === "bridge") return inboxAddressFor(proc.role, "");
	return proc.instance === undefined ? undefined : inboxAddressFor(proc.role, proc.instance);
};

/**
 * Classify every roster role's channel health from a process snapshot + the live-registered set, and
 * name the orphaned procs a reap would reap. Pure — the whole registered/deaf/orphaned discrimination
 * with no IO. The three buckets are mutually exclusive per proc: an orphan (reparented, unregistered)
 * is reaped; a parented proc is registered iff its inbox is in the attached set, else channel-deaf.
 * A role is `registered` if any attached inbox serves it, else `channel-deaf` if a deaf pane is up for
 * it, else `absent` — but every deaf pane is still surfaced in its role's `deaf` list so a mixed engine
 * pool (one instance attached, another deaf) shows the deaf one even while the role reads reachable.
 */
export const classifyCrewChannelHealth = ({
	processes,
	liveRegisteredAddresses,
	selfPid,
}: CrewChannelHealthInput): CrewChannelHealthReport => {
	const registeredByRole = new Map<CrewRole, Set<string>>();
	const deafByRole = new Map<CrewRole, DeafProc[]>();
	const orphaned: OrphanedProc[] = [];

	// Seed registered straight off the registry: an attached lease is registered even if its serving
	// proc isn't in this snapshot (a remote pane, or a `ps`-vs-lookup race).
	for (const address of liveRegisteredAddresses) {
		const role = roleOfInboxAddress(address);
		if (role === undefined) continue;
		const set = registeredByRole.get(role) ?? new Set<string>();
		set.add(address);
		registeredByRole.set(role, set);
	}

	for (const entry of processes) {
		const proc = parseCrewSessionProc(entry.command);
		if (proc === undefined) continue;
		if (entry.pid === selfPid) continue;
		if (isOrphanedCrewServer(entry, {selfPid, liveRegisteredAddresses})) {
			orphaned.push({pid: entry.pid, role: proc.role, instance: proc.instance});
			continue;
		}
		// A reparented proc the reaper spared is a still-serving engine instance — already registry-seeded.
		if (entry.ppid === INIT_PID) continue;
		// Parented ⇒ its launch pane is up. Registered iff its inbox is attached, else channel-deaf.
		const address = crewProcInboxAddress(proc);
		if (address !== undefined && liveRegisteredAddresses.has(address)) continue;
		const list = deafByRole.get(proc.role) ?? [];
		list.push({pid: entry.pid, role: proc.role, instance: proc.instance});
		deafByRole.set(proc.role, list);
	}

	const roles = CREW_ROLES.map((role): RoleChannelHealth => {
		const registered = [...(registeredByRole.get(role) ?? new Set<string>())].sort();
		const deaf = deafByRole.get(role) ?? [];
		const status: ChannelHealthStatus =
			registered.length > 0 ? "registered" : deaf.length > 0 ? "channel-deaf" : "absent";
		return {role, status, registered, deaf};
	});

	return {roles, orphaned, scanned: processes.length};
};

/** What one doctor run needs: the live-registered set, plus injectable seams defaulting to production. */
export interface CrewChannelDoctorInput {
	readonly liveRegisteredAddresses: ReadonlySet<string>;
	readonly snapshot?: ProcessSnapshot;
	readonly reaper?: ProcessReaper;
	readonly selfPid?: number;
	/** When true, drive the #C4 reaper over the orphans this run found (the fix half of the gesture). */
	readonly reap?: boolean;
}

/** A doctor run's result: the health report, plus the reap report when `--reap` drove the reaper. */
export interface CrewChannelDoctorResult {
	readonly report: CrewChannelHealthReport;
	readonly reaped: ReapReport | undefined;
}

/**
 * Run the doctor over a known live-registered set: snapshot the process table, classify channel health,
 * and — when `reap` is set — drive `reapOrphanedCrewServers` over the same set so the orphans it named
 * are terminated (the reaper re-snapshots for the actual kill, so what it reaps matches what a re-run
 * would find). The tracker dial is the caller's job (`collectLiveRegisteredForProject`), kept out so the
 * classifier + reap composition stays transport-free and fully unit-testable.
 */
export const runCrewChannelDoctor = (
	input: CrewChannelDoctorInput,
): Effect.Effect<CrewChannelDoctorResult, ProcessSnapshotError> =>
	Effect.gen(function* () {
		const snapshot = input.snapshot ?? productionProcessSnapshot;
		const selfPid = input.selfPid ?? process.pid;
		const {liveRegisteredAddresses} = input;

		const processes = yield* snapshot.list;
		const report = classifyCrewChannelHealth({processes, liveRegisteredAddresses, selfPid});

		const reaped = input.reap
			? yield* reapOrphanedCrewServers({
					liveRegisteredAddresses,
					snapshot,
					selfPid,
					...(input.reaper !== undefined ? {reaper: input.reaper} : {}),
				})
			: undefined;

		return {report, reaped};
	});

/**
 * Dial the repo's canonical rendezvous tracker (#C2, ADR 0197) and collect the live-registered
 * (attached) inbox set across the whole roster. Best-effort: an unreachable or absent tracker — no crew
 * up — yields the empty set rather than failing the doctor, so the doctor still reports every up pane as
 * channel-deaf/orphaned when the registry itself is gone (which is itself the diagnosis). Mirrors the
 * orchestration's `productionReapOrphanProcesses` tracker dial.
 */
export const collectLiveRegisteredForProject = (
	projectRoot: string,
): Effect.Effect<ReadonlySet<string>> =>
	resolveRendezvous(projectRoot).pipe(
		Effect.flatMap((rendezvous) =>
			Effect.gen(function* () {
				const crewTracker = yield* CrewTracker;
				return yield* collectLiveRegisteredAddresses((role) => crewTracker.lookup(role));
			}).pipe(Effect.scoped, Effect.provide(crewTrackerSocketLayer(rendezvous.socketPath))),
		),
		Effect.orElseSucceed(() => new Set<string>()),
	);

/** A one-glyph status marker for the operator picture — reachable / up-but-deaf / not present. */
const STATUS_GLYPH: Record<ChannelHealthStatus, string> = {
	registered: "✓ registered",
	"channel-deaf": "⚠ channel-deaf",
	absent: "· absent",
};

/**
 * Render the operator-facing channel-health report — one line per role, the orphan list, and the two
 * fix pointers stated ONCE at the foot (re-seat a deaf pane via `retire-role` → `spawn-role`, #3576;
 * `--reap` the orphans, #3629), never re-narrated per row.
 */
export const renderCrewChannelHealth = (result: CrewChannelDoctorResult): string => {
	const {report, reaped} = result;
	const lines: string[] = [];
	lines.push("crew channel health — canonical rendezvous (#C2):");
	for (const row of report.roles) {
		const detail =
			row.status === "registered"
				? ` (${row.registered.join(", ")})`
				: row.status === "channel-deaf"
					? ` (pane(s) up: ${row.deaf.map((d) => `pid ${d.pid}`).join(", ")})`
					: "";
		lines.push(`  ${row.role}: ${STATUS_GLYPH[row.status]}${detail}`);
		// A role can be reachable yet still carry a deaf instance (a mixed engine pool) — surface it.
		if (row.status === "registered" && row.deaf.length > 0) {
			lines.push(`    ⚠ also channel-deaf: ${row.deaf.map((d) => `pid ${d.pid}`).join(", ")}`);
		}
	}

	if (report.orphaned.length === 0) {
		lines.push("orphaned crew server procs: none");
	} else {
		lines.push(`orphaned crew server procs (${report.orphaned.length}):`);
		for (const orphan of report.orphaned) {
			lines.push(
				`  pid ${orphan.pid} — ${orphan.role}${orphan.instance ? `/${orphan.instance}` : ""}`,
			);
		}
	}

	if (reaped !== undefined) {
		lines.push(
			reaped.reaped.length === 0
				? "reaped: none (no orphans to reap)"
				: `reaped ${reaped.reaped.length}: ${reaped.reaped
						.map((r) => `pid ${r.pid} (${r.outcome})`)
						.join(", ")}`,
		);
	} else if (report.orphaned.length > 0) {
		lines.push("run again with --reap to terminate the orphaned procs (#3629).");
	}

	const hasDeaf = report.roles.some((row) => row.deaf.length > 0);
	if (hasDeaf) {
		lines.push("re-seat a channel-deaf role: retire-role <role> → spawn-role <role> (#3576).");
	}

	lines.push(`scanned ${report.scanned} processes.`);
	return lines.join("\n");
};
