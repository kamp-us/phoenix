/**
 * The orphan reaper (#3629): the process-table half of crash recovery. These drive orphan-vs-live
 * discrimination entirely against fixtures — no real process, `ps`, or signal — proving:
 *   - the command signature is tightly scoped (an unrelated process is never matched),
 *   - a reparented (init-adopted) crew server is reaped while a live, parented, registered session
 *     is never reaped,
 *   - the one registry-resolvable spare (a still-serving engine instance) is honored, while a
 *     day-old bridge orphan is reaped even when a live successor holds the same shared address,
 *   - the sweep is idempotent and reports what it scanned + left live.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import {
	collectLiveRegisteredAddresses,
	INIT_PID,
	isOrphanedCrewServer,
	type ProcessEntry,
	type ProcessReaper,
	type ProcessSnapshot,
	ProcessSnapshotError,
	parseCrewSessionProc,
	parseProcessTable,
	type ReapSignalOutcome,
	reapOrphanedCrewServers,
} from "./reaper.ts";
import {inboxAddressFor} from "./session.ts";

const NODE = "/opt/node/bin/node";
const BIN = "/Users/x/phoenix/packages/pipeline-crew-mcp/src/bin.ts";
/** A bridge (intake-desk) crew session server command — no `--instance` (bridges are singletons). */
const bridgeCmd = `${NODE} ${BIN} session --role intake-desk --project-root /Users/x/phoenix`;
/** An engine (engineering-manager) crew session server command — carries a per-instance `--instance`. */
const engineCmd = (instance: string) =>
	`${NODE} ${BIN} session --role engineering-manager --project-root /Users/x/phoenix --instance ${instance}`;

const empty: ReadonlySet<string> = new Set();

describe("parseCrewSessionProc — tightly-scoped signature", () => {
	it("parses a bridge session command: role, no instance", () => {
		assert.deepStrictEqual(parseCrewSessionProc(bridgeCmd), {
			role: "intake-desk",
			instance: undefined,
		});
	});
	it("parses an engine session command: role + instance", () => {
		assert.deepStrictEqual(parseCrewSessionProc(engineCmd("eng-abc")), {
			role: "engineering-manager",
			instance: "eng-abc",
		});
	});
	it("does not match a process missing the crew-mcp marker (a decoy `session --role`)", () => {
		assert.isUndefined(
			parseCrewSessionProc(`${NODE} /some/other/tool.js session --role intake-desk`),
		);
	});
	it("does not match a crew-mcp process that is not the `session` subcommand", () => {
		assert.isUndefined(parseCrewSessionProc(`${NODE} ${BIN} tracker --project-root /r`));
	});
	it("does not match a `--role` that is not a real crew role", () => {
		assert.isUndefined(parseCrewSessionProc(`${NODE} ${BIN} session --role deploy`));
	});
	it("does not match an unrelated ansible-style `--role` process", () => {
		assert.isUndefined(parseCrewSessionProc("ansible-playbook --role intake-desk site.yml"));
	});
});

describe("isOrphanedCrewServer — orphan vs live discrimination", () => {
	const selfPid = 4242;

	it("reaps a reparented (init-adopted) bridge server", () => {
		const entry: ProcessEntry = {pid: 900, ppid: INIT_PID, command: bridgeCmd};
		assert.isTrue(isOrphanedCrewServer(entry, {selfPid, liveRegisteredAddresses: empty}));
	});

	it("never reaps a live, parented crew session (ppid is its live launch pane)", () => {
		const entry: ProcessEntry = {pid: 901, ppid: 5000, command: bridgeCmd};
		const live = new Set([inboxAddressFor("intake-desk", "ignored")]);
		assert.isFalse(isOrphanedCrewServer(entry, {selfPid, liveRegisteredAddresses: live}));
	});

	it("never reaps the reaper's own process", () => {
		const entry: ProcessEntry = {pid: selfPid, ppid: INIT_PID, command: bridgeCmd};
		assert.isFalse(isOrphanedCrewServer(entry, {selfPid, liveRegisteredAddresses: empty}));
	});

	it("never reaps an unrelated init-adopted process (tight scope)", () => {
		const entry: ProcessEntry = {pid: 902, ppid: INIT_PID, command: "/usr/sbin/cupsd -l"};
		assert.isFalse(isOrphanedCrewServer(entry, {selfPid, liveRegisteredAddresses: empty}));
	});

	it("spares a reparented ENGINE whose exact per-instance address still holds a live lease", () => {
		const entry: ProcessEntry = {pid: 903, ppid: INIT_PID, command: engineCmd("eng-live")};
		const live = new Set([inboxAddressFor("engineering-manager", "eng-live")]);
		assert.isFalse(isOrphanedCrewServer(entry, {selfPid, liveRegisteredAddresses: live}));
	});

	it("reaps a reparented ENGINE whose address is NOT a live lease (its heartbeat lapsed)", () => {
		const entry: ProcessEntry = {pid: 904, ppid: INIT_PID, command: engineCmd("eng-dead")};
		const live = new Set([inboxAddressFor("engineering-manager", "eng-other")]);
		assert.isTrue(isOrphanedCrewServer(entry, {selfPid, liveRegisteredAddresses: live}));
	});

	it("reaps a day-old reparented BRIDGE orphan even when a live successor holds the shared address", () => {
		// A bridge address (`inbox://intake-desk`) is shared across re-runs, so a live successor's lease
		// cannot vouch for a reparented predecessor — the ppid signal reaps the zombie, which is the whole
		// point of the fix (a re-run must not leave the old bridge server behind).
		const entry: ProcessEntry = {pid: 905, ppid: INIT_PID, command: bridgeCmd};
		const live = new Set([inboxAddressFor("intake-desk", "ignored")]);
		assert.isTrue(isOrphanedCrewServer(entry, {selfPid, liveRegisteredAddresses: live}));
	});
});

/** A recording reaper: captures the pids it was asked to kill, resolving each to a scripted outcome. */
const recordingReaper = (
	killed: number[],
	outcome: (pid: number) => ReapSignalOutcome = () => "signalled",
): ProcessReaper => ({
	kill: (pid) =>
		Effect.sync(() => {
			killed.push(pid);
			return outcome(pid);
		}),
});

const snapshotOf = (entries: ReadonlyArray<ProcessEntry>): ProcessSnapshot => ({
	list: Effect.succeed(entries),
});

describe("reapOrphanedCrewServers — the sweep", () => {
	it.effect("reaps exactly the orphans, leaving live + unrelated + self untouched", () =>
		Effect.gen(function* () {
			const selfPid = 100;
			const entries: ProcessEntry[] = [
				{pid: selfPid, ppid: INIT_PID, command: bridgeCmd}, // self — never reaped
				{pid: 200, ppid: 5000, command: bridgeCmd}, // live parented bridge
				{pid: 201, ppid: INIT_PID, command: bridgeCmd}, // orphan bridge → reap
				{pid: 202, ppid: INIT_PID, command: engineCmd("eng-dead")}, // orphan engine → reap
				{pid: 203, ppid: INIT_PID, command: engineCmd("eng-live")}, // orphan engine, still-live lease → spare
				{pid: 204, ppid: INIT_PID, command: "/usr/sbin/cupsd"}, // unrelated init child
			];
			const killed: number[] = [];
			const report = yield* reapOrphanedCrewServers({
				liveRegisteredAddresses: new Set([
					inboxAddressFor("engineering-manager", "eng-live"),
					inboxAddressFor("intake-desk", "ignored"),
				]),
				snapshot: snapshotOf(entries),
				reaper: recordingReaper(killed),
				selfPid,
			});
			assert.deepStrictEqual(killed.sort(), [201, 202]);
			assert.deepStrictEqual(report.reaped.map((r) => r.pid).sort(), [201, 202]);
			assert.strictEqual(report.scanned, entries.length);
			assert.deepStrictEqual(report.reaped.find((r) => r.pid === 201)?.role, "intake-desk");
			assert.deepStrictEqual(report.reaped.find((r) => r.pid === 202)?.instance, "eng-dead");
		}),
	);

	it.effect("is idempotent: a re-run finds the reaped procs gone and kills nothing", () =>
		Effect.gen(function* () {
			const killed: number[] = [];
			const report = yield* reapOrphanedCrewServers({
				liveRegisteredAddresses: empty,
				// The reaped orphan is no longer in the table on the next pass.
				snapshot: snapshotOf([{pid: 200, ppid: 5000, command: bridgeCmd}]),
				reaper: recordingReaper(killed),
				selfPid: 100,
			});
			assert.deepStrictEqual(killed, []);
			assert.deepStrictEqual(report.reaped, []);
		}),
	);

	it.effect("reports an already-gone orphan without failing (kill lost the race)", () =>
		Effect.gen(function* () {
			const killed: number[] = [];
			const report = yield* reapOrphanedCrewServers({
				liveRegisteredAddresses: empty,
				snapshot: snapshotOf([{pid: 201, ppid: INIT_PID, command: bridgeCmd}]),
				reaper: recordingReaper(killed, () => "already-gone"),
				selfPid: 100,
			});
			assert.deepStrictEqual(killed, [201]);
			assert.strictEqual(report.reaped[0]?.outcome, "already-gone");
		}),
	);

	it.effect("surfaces a process-snapshot failure (never a silent zero-orphan pass)", () =>
		Effect.gen(function* () {
			const exit = yield* reapOrphanedCrewServers({
				liveRegisteredAddresses: empty,
				snapshot: {list: Effect.fail(new ProcessSnapshotError({reason: "ps -A failed: boom"}))},
				reaper: recordingReaper([]),
				selfPid: 100,
			}).pipe(Effect.flip);
			assert.instanceOf(exit, ProcessSnapshotError);
		}),
	);
});

describe("parseProcessTable — ps output parsing", () => {
	it("parses `<pid> <ppid> <args…>` rows and skips unparseable lines", () => {
		const out = [
			"  201     1 /opt/node/bin/node /p/pipeline-crew-mcp/src/bin.ts session --role intake-desk",
			"  200  5000 /opt/node/bin/node /p/pipeline-crew-mcp/src/bin.ts session --role chief-of-staff",
			"garbage line with no leading pid",
			"",
		].join("\n");
		assert.deepStrictEqual(parseProcessTable(out), [
			{
				pid: 201,
				ppid: 1,
				command: "/opt/node/bin/node /p/pipeline-crew-mcp/src/bin.ts session --role intake-desk",
			},
			{
				pid: 200,
				ppid: 5000,
				command: "/opt/node/bin/node /p/pipeline-crew-mcp/src/bin.ts session --role chief-of-staff",
			},
		]);
	});
});

describe("collectLiveRegisteredAddresses — union across the roster", () => {
	it.effect("unions every present peer across all roles into one address set", () =>
		Effect.gen(function* () {
			const present: Record<string, ReadonlyArray<{readonly peer: string}>> = {
				"intake-desk": [{peer: "inbox://intake-desk"}],
				"engineering-manager": [
					{peer: "inbox://engineering-manager/a"},
					{peer: "inbox://engineering-manager/b"},
				],
			};
			const addresses = yield* collectLiveRegisteredAddresses((role) =>
				Effect.succeed(present[role] ?? []),
			);
			assert.deepStrictEqual([...addresses].sort(), [
				"inbox://engineering-manager/a",
				"inbox://engineering-manager/b",
				"inbox://intake-desk",
			]);
		}),
	);
});
