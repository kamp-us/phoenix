/**
 * Claim-presence — the pure half of ADR 0191 liveness for a GitHub claim marker (#3751).
 *
 * A claim marker may carry an optional presence stamp, `claim: <session> · <ts> · presence
 * <host>/<pid>`, where `<pid>` is the claiming **session process** (the long-lived `claude`
 * ancestor of the process that posted the claim, the same identification `worktree-reap` makes)
 * and `<host>` is a fingerprint of the machine it runs on. That stamp is what turns "is this
 * claimant still alive?" from a judgment call into a probe, so a dead session's marker stops
 * shadowing every later legitimate claim on an abandoned lane.
 *
 * The one non-obvious thing: **only positive evidence of death supersedes a claim.** A missing
 * stamp (a legacy marker), a stamp from another machine, an unresolvable local machine identity,
 * or an unprobeable pid all resolve `unknown`, which counts as a live claim — so an indeterminate
 * claimant is refused, never evicted (the slow-but-live-agent hazard ADR 0115 §5 deferred reclaim
 * over). A reused pid reads running ⇒ live, the same fail-safe direction `worktree-reap` takes.
 */
import {createHash} from "node:crypto";
import type {ClaimComment, ClaimLiveness} from "./claim-resolution.ts";

/** The claimant's session process, as stamped on the marker. */
export interface ClaimPresence {
	/**
	 * An opaque fingerprint of the **machine identity** the session process runs on — a claim
	 * stamped elsewhere is unprobeable here. Only equality is ever asked of it, so it is a hash
	 * rather than the identity itself. Why it must fingerprint a machine-scoped id and never the
	 * hostname: `presence-io.ts` `readMachineId`.
	 */
	readonly host: string;
	/** The session process id whose presence IS the claim's liveness (ADR 0191). */
	readonly pid: number;
}

/**
 * The optional presence suffix of a claim marker. Anchored to the end of the marker's FIRST
 * line (claim markers are one line; a stamp is never read out of trailing prose), tolerant of
 * either `·` or `-` as the separator the writers emit.
 */
export const PRESENCE_RE = /[·-]\s*presence\s+([^\s/]+)\/(\d+)\s*$/i;

/** Format the suffix `claimCommentBody` appends — the single source of the stamp's shape. */
export const formatClaimPresence = (presence: ClaimPresence): string =>
	`presence ${presence.host}/${presence.pid}`;

/** Parse a marker's presence stamp, or `null` when it carries none (the legacy/unstamped case). */
export const parseClaimPresence = (body: string): ClaimPresence | null => {
	const firstLine = body.split("\n", 1)[0] ?? "";
	const match = PRESENCE_RE.exec(firstLine);
	const host = match?.[1];
	const rawPid = match?.[2];
	if (host === undefined || rawPid === undefined) return null;
	const pid = Number.parseInt(rawPid, 10);
	return Number.isFinite(pid) && pid > 0 ? {host, pid} : null;
};

/** What a pid probe could establish. `unprobeable` is a failed probe, never "gone". */
export type PidState = "running" | "gone" | "unprobeable";

/** This machine's identity + its pid probe — the boundary facts the classification reads. */
export interface LocalPresence {
	/**
	 * This machine's fingerprint, or `null` when the machine identity could not be resolved. `null`
	 * is not a wildcard: it makes the host comparison **inconclusive** (⇒ `unknown` ⇒ the claim
	 * stands), because a machine we cannot identify is a machine whose pids we cannot attribute.
	 */
	readonly host: string | null;
	readonly probePid: (pid: number) => PidState;
}

/** How many hex chars of the digest the fingerprint carries — collision-free at machine scale. */
const FINGERPRINT_LEN = 12;

/**
 * Fingerprint a machine identity for the stamp: a truncated SHA-256, or `null` for an absent or
 * blank id. Hashing is what keeps the raw identity out of a public timeline — and it is required
 * of a Linux `/etc/machine-id`, which systemd's `machine-id(5)` declares confidential and directs
 * callers to use only via an application-specific derivation (`sd_id128_get_machine_app_specific`).
 */
export const machineFingerprint = (machineId: string | null | undefined): string | null => {
	const id = machineId?.trim().toLowerCase() ?? "";
	if (id === "") return null;
	return createHash("sha256").update(id).digest("hex").slice(0, FINGERPRINT_LEN);
};

/** The `IOPlatformUUID` property line `ioreg -rd1 -c IOPlatformExpertDevice` prints on macOS. */
const IOREG_PLATFORM_UUID_RE = /"IOPlatformUUID"\s*=\s*"([^"]+)"/;

/** Read the hardware UUID out of `ioreg` output, or `null` when the property is absent. */
export const parseIOPlatformUuid = (ioregOutput: string): string | null =>
	IOREG_PLATFORM_UUID_RE.exec(ioregOutput)?.[1]?.trim() || null;

/**
 * Classify one claim's liveness. `dead` requires all three: a stamp, a host match against a
 * RESOLVED local machine fingerprint (we can only probe our own machine), and a pid the probe
 * proves gone. Everything else — including an unresolvable local identity — is `unknown`.
 */
export const claimLiveness = (
	presence: ClaimPresence | null,
	local: LocalPresence,
): ClaimLiveness => {
	if (presence === null) return "unknown";
	if (local.host === null) return "unknown";
	if (presence.host !== local.host) return "unknown";
	switch (local.probePid(presence.pid)) {
		case "gone":
			return "dead";
		case "running":
			return "live";
		case "unprobeable":
			return "unknown";
	}
};

/**
 * The per-comment-id liveness map `resolveWinner`/`resolveClaim` consume. Only entries that
 * resolve to something other than `unknown` are recorded, so the map is empty (⇒ resolution
 * identical to the pre-supersession behaviour) whenever nothing is provable.
 */
export const livenessByComment = (
	comments: ReadonlyArray<ClaimComment>,
	local: LocalPresence,
): ReadonlyMap<number, ClaimLiveness> => {
	const map = new Map<number, ClaimLiveness>();
	for (const comment of comments) {
		const liveness = claimLiveness(parseClaimPresence(comment.body), local);
		if (liveness !== "unknown") map.set(comment.id, liveness);
	}
	return map;
};

/** One row of the process table the session-pid walk reads. */
export interface ProcessRow {
	readonly ppid: number;
	readonly command: string;
}

/**
 * Parse `ps -Ao pid=,ppid=,comm=` output into a pid → `{ppid, command}` table. Tolerates the
 * leading padding `ps` emits and a command path with spaces; a malformed row is skipped.
 */
export const parseProcessTable = (psOutput: string): ReadonlyMap<number, ProcessRow> => {
	const table = new Map<number, ProcessRow>();
	for (const line of psOutput.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
		const rawPid = match?.[1];
		const rawPpid = match?.[2];
		const command = match?.[3];
		if (rawPid === undefined || rawPpid === undefined || command === undefined) continue;
		table.set(Number.parseInt(rawPid, 10), {ppid: Number.parseInt(rawPpid, 10), command});
	}
	return table;
};

/** The session process's command basename — the harness names it `claude`. */
const SESSION_COMMAND = "claude";

/** Bound the ancestor walk so a malformed/cyclic table can never spin. */
const MAX_ANCESTOR_HOPS = 64;

/**
 * The nearest `claude` ancestor of `startPid` (inclusive) — the long-lived session process
 * whose presence a claim's liveness rides. `null` when the walk finds none (a CLI run outside a
 * session, a table that could not be read): the writer then stamps NO presence, which reads
 * `unknown` downstream, so an unresolvable session degrades to today's behaviour.
 */
export const resolveSessionPid = (
	table: ReadonlyMap<number, ProcessRow>,
	startPid: number,
): number | null => {
	let pid = startPid;
	for (let hop = 0; hop < MAX_ANCESTOR_HOPS; hop++) {
		const row = table.get(pid);
		if (row === undefined) return null;
		if (row.command.split("/").pop() === SESSION_COMMAND) return pid;
		if (row.ppid <= 1 || row.ppid === pid) return null;
		pid = row.ppid;
	}
	return null;
};
