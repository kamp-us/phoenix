import {assert, describe, it} from "@effect/vitest";
import {
	claimLiveness,
	formatClaimPresence,
	type LocalPresence,
	livenessByComment,
	machineFingerprint,
	type PidState,
	parseClaimPresence,
	parseIOPlatformUuid,
	parseProcessTable,
	resolveSessionPid,
} from "./claim-presence.ts";
import {type ClaimComment, claimCommentBody} from "./claim-resolution.ts";

const SID_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SID_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const local = (host: string | null, states: Record<number, PidState>): LocalPresence => ({
	host,
	probePid: (pid) => states[pid] ?? "unprobeable",
});

const comment = (id: number, body: string): ClaimComment => ({
	id,
	author: "usirin",
	createdAt: "2026-07-22T05:33:00Z",
	body,
});

describe("parseClaimPresence — the optional presence stamp on a claim marker", () => {
	it("reads host + pid off a stamped marker", () => {
		assert.deepStrictEqual(
			parseClaimPresence(`claim: ${SID_A} · 2026-07-20T06:42:00Z · presence box-1/4242`),
			{host: "box-1", pid: 4242},
		);
	});

	it("round-trips the composer's own output (one grammar, two directions)", () => {
		const presence = {host: "box-1", pid: 4242};
		assert.deepStrictEqual(
			parseClaimPresence(
				claimCommentBody(SID_A, "2026-07-20T06:42:00Z", formatClaimPresence(presence)),
			),
			presence,
		);
	});

	it("an unstamped (legacy) marker carries no presence", () => {
		assert.strictEqual(parseClaimPresence(`claim: ${SID_A} · 2026-07-20T06:42:00Z`), null);
	});

	it("never reads a stamp out of trailing prose — the marker's first line only", () => {
		assert.strictEqual(
			parseClaimPresence(`claim: ${SID_A} · 2026-07-20T06:42:00Z\nnot a presence box-1/4242`),
			null,
		);
	});
});

describe("claimLiveness — dead requires positive evidence, everything else is indeterminate", () => {
	it("host match + a provably gone pid ⇒ dead (the supersession trigger)", () => {
		assert.strictEqual(
			claimLiveness({host: "box-1", pid: 4242}, local("box-1", {4242: "gone"})),
			"dead",
		);
	});

	it("host match + a running pid ⇒ live (never evict a slow-but-live agent)", () => {
		assert.strictEqual(
			claimLiveness({host: "box-1", pid: 4242}, local("box-1", {4242: "running"})),
			"live",
		);
	});

	it("another host ⇒ unknown — we cannot probe someone else's machine", () => {
		assert.strictEqual(
			claimLiveness({host: "box-2", pid: 4242}, local("box-1", {4242: "gone"})),
			"unknown",
		);
	});

	it("an unprobeable pid ⇒ unknown, never dead", () => {
		assert.strictEqual(
			claimLiveness({host: "box-1", pid: 4242}, local("box-1", {4242: "unprobeable"})),
			"unknown",
		);
	});

	it("no stamp ⇒ unknown", () => {
		assert.strictEqual(claimLiveness(null, local("box-1", {})), "unknown");
	});

	// #3992: the fingerprint must identify a MACHINE, and an identity we cannot resolve must be
	// inconclusive — never a match that licenses a pid probe against a foreign machine's pid.
	it("an UNRESOLVABLE local machine identity ⇒ unknown even for a provably gone pid", () => {
		assert.strictEqual(
			claimLiveness({host: "box-1", pid: 4242}, local(null, {4242: "gone"})),
			"unknown",
		);
	});

	it("two machines that SHARE a hostname but not a machine id never match ⇒ unknown, never dead", () => {
		const stampedOnMachineA = machineFingerprint("6553E4B9-1D64-5AFC-82F5-C0A5B666C380");
		const readerIsMachineB = machineFingerprint("1FA3D0C7-9E2B-5D11-B4A6-77C1E0F58322");
		assert.notStrictEqual(stampedOnMachineA, readerIsMachineB);
		assert.strictEqual(
			claimLiveness(
				{host: stampedOnMachineA ?? "", pid: 4242},
				local(readerIsMachineB, {4242: "gone"}),
			),
			"unknown",
		);
	});
});

describe("machineFingerprint — a hashed MACHINE identity, or nothing", () => {
	it("is stable for one id and distinct across machines (the only two properties asked of it)", () => {
		const a = machineFingerprint("6553E4B9-1D64-5AFC-82F5-C0A5B666C380");
		assert.strictEqual(a, machineFingerprint("6553e4b9-1d64-5afc-82f5-c0a5b666c380"));
		assert.notStrictEqual(a, machineFingerprint("1FA3D0C7-9E2B-5D11-B4A6-77C1E0F58322"));
	});

	it("never leaks the raw identity into the stamp", () => {
		const fingerprint = machineFingerprint("6553E4B9-1D64-5AFC-82F5-C0A5B666C380");
		assert.strictEqual(fingerprint?.length, 12);
		assert.isFalse((fingerprint ?? "").includes("6553e4b9"));
	});

	it("an absent or blank machine id ⇒ null (fail toward indeterminate, never a shared bucket)", () => {
		assert.strictEqual(machineFingerprint(null), null);
		assert.strictEqual(machineFingerprint(undefined), null);
		assert.strictEqual(machineFingerprint("   \n"), null);
	});
});

describe("parseIOPlatformUuid — the darwin machine identity", () => {
	it("reads IOPlatformUUID out of ioreg output", () => {
		assert.strictEqual(
			parseIOPlatformUuid(
				[
					'    "IOPlatformSerialNumber" = "XXXXXXXXXXXX"',
					'    "IOPlatformUUID" = "6553E4B9-1D64-5AFC-82F5-C0A5B666C380"',
				].join("\n"),
			),
			"6553E4B9-1D64-5AFC-82F5-C0A5B666C380",
		);
	});

	it("no such property ⇒ null (⇒ no fingerprint ⇒ indeterminate)", () => {
		assert.strictEqual(parseIOPlatformUuid('  "IOPlatformSerialNumber" = "XXXXXXXXXXXX"'), null);
	});
});

describe("livenessByComment — only provable states are recorded", () => {
	it("maps the dead and live claims and omits every indeterminate one", () => {
		const comments = [
			comment(10, `claim: ${SID_A} · 2026-07-20T06:42:00Z · presence box-1/4242`),
			comment(20, `claim: ${SID_B} · 2026-07-22T05:33:00Z · presence box-1/5150`),
			comment(30, `claim: ${SID_B} · 2026-07-22T05:34:00Z · presence box-2/999`),
			comment(40, `claim: ${SID_B} · 2026-07-22T05:35:00Z`),
			comment(50, "not a claim at all"),
		];
		assert.deepStrictEqual(
			[...livenessByComment(comments, local("box-1", {4242: "gone", 5150: "running"}))],
			[
				[10, "dead"],
				[20, "live"],
			],
		);
	});
});

describe("resolveSessionPid — the nearest `claude` ancestor is the session process", () => {
	const table = parseProcessTable(
		["  9001  8001 node", " 8001  7001 -zsh", " 7001     1 claude", "   1     0 launchd"].join(
			"\n",
		),
	);

	it("walks the ppid chain to the session process", () => {
		assert.strictEqual(resolveSessionPid(table, 9001), 7001);
	});

	it("resolves to itself when the start pid IS the session", () => {
		assert.strictEqual(resolveSessionPid(table, 7001), 7001);
	});

	it("no session ancestor ⇒ null (the writer then stamps nothing, reading indeterminate)", () => {
		assert.strictEqual(resolveSessionPid(table, 1), null);
	});

	it("an unknown start pid ⇒ null, never a guess", () => {
		assert.strictEqual(resolveSessionPid(table, 4242), null);
	});

	it("a self-parenting row terminates instead of spinning", () => {
		const cyclic = parseProcessTable(" 500 500 node");
		assert.strictEqual(resolveSessionPid(cyclic, 500), null);
	});
});
