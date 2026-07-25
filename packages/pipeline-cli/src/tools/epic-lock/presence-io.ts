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
import {readFileSync} from "node:fs";
import {
	type ClaimPresence,
	type LocalPresence,
	machineFingerprint,
	type PidState,
	parseIOPlatformUuid,
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
 * This machine's identity, per platform, or `null` when none can be read.
 *
 * A **hostname is not a machine identity** — two machines routinely share one (`localhost`, a
 * default container/CI name), and a colliding fingerprint would make a cross-machine claim look
 * same-machine and evict a live agent (#3986 review F3). So each source below is machine-scoped
 * and reboot-stable, grounded rather than assumed:
 *
 * - **darwin:** `IOPlatformUUID` on `IOPlatformExpertDevice`. Verified on an M2 Mac to equal
 *   `system_profiler SPHardwareDataType`'s **Hardware UUID** — the per-unit hardware identifier,
 *   which is exactly why it is stable across reboots and distinct per machine (and it differed
 *   from that machine's hostname).
 * - **linux:** `/etc/machine-id`, falling back to `/var/lib/dbus/machine-id` — systemd's
 *   `machine-id(5)`: an id "unique for the local system", set at install and "stable across
 *   reboots".
 *
 * Any other platform, or an unreadable source, yields `null` ⇒ the host comparison is
 * inconclusive ⇒ every claim reads indeterminate and stands. Never substitute the hostname here.
 */
export const readMachineId = (): string | null => {
	try {
		if (process.platform === "darwin") {
			return parseIOPlatformUuid(
				execFileSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {encoding: "utf8"}),
			);
		}
		if (process.platform === "linux") {
			for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
				try {
					const id = readFileSync(path, "utf8").trim();
					if (id !== "") return id;
				} catch {}
			}
		}
		return null;
	} catch {
		return null;
	}
};

/**
 * This machine's stamp identity: a truncated hash of its machine id, or `null` when unresolvable.
 * Liveness only ever asks "was this claim stamped on MY machine?", so a fingerprint answers it
 * exactly — and keeps the identity out of a public issue timeline (the no-local-identity rule the
 * leak-guards enforce generically).
 */
const machineStampIdentity = (): string | null => machineFingerprint(readMachineId());

/** This machine's presence facts — the reader side. */
export const localPresence = (): LocalPresence => ({host: machineStampIdentity(), probePid});

/**
 * The presence stamp for THIS run's claim: the nearest `claude` ancestor of the current process
 * (the session whose liveness the claim rides) on this machine. `null` when the process table
 * cannot be read, no session ancestor resolves, or this machine has no resolvable identity — the
 * writer then emits an unstamped marker, which every reader treats as indeterminate.
 */
export const currentSessionPresence = (): ClaimPresence | null => {
	try {
		const host = machineStampIdentity();
		if (host === null) return null;
		const table = parseProcessTable(
			execFileSync("ps", ["-Ao", "pid=,ppid=,comm="], {encoding: "utf8"}),
		);
		const pid = resolveSessionPid(table, process.pid);
		return pid === null ? null : {host, pid};
	} catch {
		return null;
	}
};
