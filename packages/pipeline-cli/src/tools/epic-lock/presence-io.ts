/**
 * The OS boundary for claim presence (`claim-presence.ts` holds the decisions). Two
 * best-effort reads, both of which degrade to "nothing provable" rather than to a wrong answer:
 * the local host + pid probe a reader classifies liveness with, and the presence stamp a writer
 * puts on its own claim.
 *
 * Deliberately synchronous and outside the Effect `E` channel: every failure here is already
 * modelled as an absence (`unprobeable` / no stamp) that the pure classification treats
 * fail-closed, so lowering it into a typed error would add a channel no caller can act on.
 */
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {hostname} from "node:os";
import {
	type ClaimPresence,
	type LocalPresence,
	type PidState,
	parseProcessTable,
	resolveSessionPid,
} from "./claim-presence.ts";

/**
 * Probe one pid with signal 0: no error ⇒ running; `ESRCH` ⇒ provably gone (the one positive
 * death signal); `EPERM` (alive but owned by another user) and anything else ⇒ unprobeable.
 */
const probePid = (pid: number): PidState => {
	// `process.kill(pid, 0)` signals all three outcomes by throwing (or not), so the try/catch IS
	// the probe — each branch maps to a total `PidState`, never to an error channel.
	try {
		process.kill(pid, 0);
		return "running";
	} catch (cause) {
		return (cause as {code?: string} | null)?.code === "ESRCH" ? "gone" : "unprobeable";
	}
};

/**
 * This machine's stamp identity: a truncated hash of the hostname. Liveness only ever asks
 * "was this claim stamped on MY host?", so a fingerprint answers it exactly — and keeps the
 * operator's machine name out of a public issue timeline (the no-local-identity rule the
 * leak-guards enforce generically).
 */
const hostFingerprint = (): string =>
	createHash("sha256").update(hostname()).digest("hex").slice(0, 12);

/** This machine's presence facts — the reader side. */
export const localPresence = (): LocalPresence => ({host: hostFingerprint(), probePid});

/**
 * The presence stamp for THIS run's claim: the nearest `claude` ancestor of the current process
 * (the session whose liveness the claim rides) on this host. `null` when the process table
 * cannot be read or no session ancestor resolves — the writer then emits an unstamped marker,
 * which every reader treats as indeterminate.
 */
export const currentSessionPresence = (): ClaimPresence | null => {
	try {
		const table = parseProcessTable(
			execFileSync("ps", ["-Ao", "pid=,ppid=,comm="], {encoding: "utf8"}),
		);
		const pid = resolveSessionPid(table, process.pid);
		return pid === null ? null : {host: hostFingerprint(), pid};
	} catch {
		return null;
	}
};
