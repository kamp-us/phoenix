/**
 * The crew channel doctor (#3630): one command to SEE and FIX crew channel health. These drive the
 * pure classifier + the reap composition entirely against fixtures — no real process, `ps`, tracker,
 * or signal — proving:
 *   - a role with an attached inbox is REGISTERED, a parented pane with no attached half is
 *     CHANNEL-DEAF, a reparented (init-adopted) proc is ORPHANED, and a role with neither is ABSENT,
 *   - the three are distinguished on ONE mixed registered/deaf/orphaned fixture (AC1/AC2/AC3),
 *   - orphan identification is the reaper's (`isOrphanedCrewServer`), so the report matches what a reap
 *     terminates, and `--reap` drives the reaper over exactly those orphans,
 *   - a mixed engine pool (one instance attached, one deaf) reads reachable yet still surfaces the deaf
 *     instance, and the render names each state + the fix pointers once.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import {
	classifyCrewChannelHealth,
	crewProcInboxAddress,
	renderCrewChannelHealth,
	roleOfInboxAddress,
	runCrewChannelDoctor,
} from "./doctor.ts";
import {INIT_PID, type ProcessEntry, type ProcessReaper, type ProcessSnapshot} from "./reaper.ts";
import type {CrewRole} from "./roles.ts";
import {inboxAddressFor} from "./session.ts";

const NODE = "/opt/node/bin/node";
const BIN = "/Users/x/phoenix/packages/pipeline-crew-mcp/src/bin.ts";
/** A bridge crew session server command — no `--instance` (bridges are singletons). */
const bridgeCmd = (role: CrewRole) =>
	`${NODE} ${BIN} session --role ${role} --project-root /Users/x/phoenix`;
/** An engine crew session server command — carries a per-instance `--instance`. */
const engineCmd = (instance: string) =>
	`${NODE} ${BIN} session --role engineering-manager --project-root /Users/x/phoenix --instance ${instance}`;

const LIVE_PANE_PPID = 5000;

describe("roleOfInboxAddress — the inbox → role inverse", () => {
	it("resolves a bridge address `inbox://<role>`", () => {
		assert.strictEqual(roleOfInboxAddress("inbox://intake-desk"), "intake-desk");
	});
	it("resolves an engine address `inbox://<role>/<instance>`", () => {
		assert.strictEqual(
			roleOfInboxAddress("inbox://engineering-manager/eng-1"),
			"engineering-manager",
		);
	});
	it("rejects a non-inbox address and a non-crew role", () => {
		assert.isUndefined(roleOfInboxAddress("tcp://intake-desk"));
		assert.isUndefined(roleOfInboxAddress("inbox://deploy"));
	});
});

describe("crewProcInboxAddress — a parsed proc's dialable address", () => {
	it("a bridge folds no instance into its address", () => {
		assert.strictEqual(
			crewProcInboxAddress({role: "intake-desk", instance: undefined}),
			"inbox://intake-desk",
		);
	});
	it("an engine carries its per-instance discriminator", () => {
		assert.strictEqual(
			crewProcInboxAddress({role: "engineering-manager", instance: "eng-1"}),
			"inbox://engineering-manager/eng-1",
		);
	});
	it("an engine with no argv --instance can't be pinned down (never mistaken for registered)", () => {
		assert.isUndefined(crewProcInboxAddress({role: "engineering-manager", instance: undefined}));
	});
});

describe("classifyCrewChannelHealth — the mixed registered/deaf/orphaned fixture (AC1/AC2/AC3)", () => {
	const selfPid = 4242;
	// intake-desk: pane up AND attached ⇒ registered.
	// chief-of-staff: pane up but NOT attached ⇒ channel-deaf (#C3).
	// engineering-manager (eng-orphan): reparented to init, not registered ⇒ orphaned (#C4).
	// cartographer: no pane, no registration ⇒ absent.
	const processes: ReadonlyArray<ProcessEntry> = [
		{pid: 100, ppid: LIVE_PANE_PPID, command: bridgeCmd("intake-desk")},
		{pid: 200, ppid: LIVE_PANE_PPID, command: bridgeCmd("chief-of-staff")},
		{pid: 300, ppid: INIT_PID, command: engineCmd("eng-orphan")},
		{pid: 999, ppid: LIVE_PANE_PPID, command: "/usr/sbin/cupsd -l"}, // decoy, never matched
	];
	const liveRegisteredAddresses = new Set([inboxAddressFor("intake-desk", "")]);

	const report = classifyCrewChannelHealth({processes, liveRegisteredAddresses, selfPid});
	const rowFor = (role: CrewRole) => report.roles.find((r) => r.role === role);

	it("a live attached inbox reads REGISTERED, distinct from deaf and absent", () => {
		assert.strictEqual(rowFor("intake-desk")?.status, "registered");
		assert.deepStrictEqual(rowFor("intake-desk")?.registered, ["inbox://intake-desk"]);
	});

	it("a pane up with no attached channel half reads CHANNEL-DEAF (#C3)", () => {
		const row = rowFor("chief-of-staff");
		assert.strictEqual(row?.status, "channel-deaf");
		assert.deepStrictEqual(
			row?.deaf.map((d) => d.pid),
			[200],
		);
	});

	it("a reparented, unregistered proc is ORPHANED (#C4), matching the reaper", () => {
		assert.deepStrictEqual(
			report.orphaned.map((o) => ({pid: o.pid, role: o.role, instance: o.instance})),
			[{pid: 300, role: "engineering-manager", instance: "eng-orphan"}],
		);
	});

	it("a role with neither a pane nor a registration reads ABSENT", () => {
		assert.strictEqual(rowFor("cartographer")?.status, "absent");
	});

	it("scans the whole table (the decoy is counted, never matched)", () => {
		assert.strictEqual(report.scanned, 4);
	});
});

describe("classifyCrewChannelHealth — a mixed engine pool", () => {
	const selfPid = 1;
	it("reads registered on the attached instance yet still surfaces the deaf instance", () => {
		const processes: ReadonlyArray<ProcessEntry> = [
			{pid: 10, ppid: LIVE_PANE_PPID, command: engineCmd("eng-live")},
			{pid: 11, ppid: LIVE_PANE_PPID, command: engineCmd("eng-deaf")},
		];
		const live = new Set([inboxAddressFor("engineering-manager", "eng-live")]);
		const report = classifyCrewChannelHealth({processes, liveRegisteredAddresses: live, selfPid});
		const row = report.roles.find((r) => r.role === "engineering-manager");
		assert.strictEqual(row?.status, "registered");
		assert.deepStrictEqual(
			row?.deaf.map((d) => d.instance),
			["eng-deaf"],
		);
	});
});

describe("runCrewChannelDoctor — the injected-seam composition", () => {
	const selfPid = 4242;
	const snapshotOf = (entries: ReadonlyArray<ProcessEntry>): ProcessSnapshot => ({
		list: Effect.succeed(entries),
	});

	it.effect("does not reap without --reap, and reports the orphans it found", () =>
		Effect.gen(function* () {
			const killed: number[] = [];
			const reaper: ProcessReaper = {
				kill: (pid) =>
					Effect.sync(() => {
						killed.push(pid);
						return "signalled";
					}),
			};
			const result = yield* runCrewChannelDoctor({
				liveRegisteredAddresses: new Set(),
				snapshot: snapshotOf([{pid: 300, ppid: INIT_PID, command: bridgeCmd("intake-desk")}]),
				reaper,
				selfPid,
			});
			assert.deepStrictEqual(killed, [], "no kill without --reap");
			assert.isUndefined(result.reaped);
			assert.strictEqual(result.report.orphaned.length, 1);
		}),
	);

	it.effect("with --reap, drives the reaper over exactly the orphaned procs", () =>
		Effect.gen(function* () {
			const killed: number[] = [];
			const reaper: ProcessReaper = {
				kill: (pid) =>
					Effect.sync(() => {
						killed.push(pid);
						return "signalled";
					}),
			};
			const result = yield* runCrewChannelDoctor({
				liveRegisteredAddresses: new Set(),
				snapshot: snapshotOf([
					{pid: 300, ppid: INIT_PID, command: bridgeCmd("intake-desk")},
					{pid: 301, ppid: 5000, command: bridgeCmd("chief-of-staff")}, // parented → deaf, never reaped
				]),
				reaper,
				selfPid,
				reap: true,
			});
			assert.deepStrictEqual(killed, [300], "only the orphan is reaped, not the deaf pane");
			assert.strictEqual(result.reaped?.reaped.length, 1);
		}),
	);
});

describe("renderCrewChannelHealth — names each state + the fix pointers once", () => {
	const selfPid = 4242;
	it("renders registered/deaf/orphaned lines and the re-seat + reap hints", () => {
		const report = classifyCrewChannelHealth({
			processes: [
				{pid: 100, ppid: 5000, command: bridgeCmd("intake-desk")},
				{pid: 200, ppid: 5000, command: bridgeCmd("chief-of-staff")},
				{pid: 300, ppid: INIT_PID, command: engineCmd("eng-orphan")},
			],
			liveRegisteredAddresses: new Set([inboxAddressFor("intake-desk", "")]),
			selfPid,
		});
		const text = renderCrewChannelHealth({report, reaped: undefined});
		assert.match(text, /intake-desk: ✓ registered/);
		assert.match(text, /chief-of-staff: ⚠ channel-deaf/);
		assert.match(text, /orphaned crew server procs \(1\)/);
		assert.match(text, /retire-role .* spawn-role/, "the deaf-role fix pointer, stated once");
		assert.match(text, /--reap/, "the reap hint when orphans exist and none reaped");
		// The re-seat pointer appears exactly once (stated once, not per-row).
		assert.strictEqual((text.match(/retire-role/g) ?? []).length, 1);
	});
});
