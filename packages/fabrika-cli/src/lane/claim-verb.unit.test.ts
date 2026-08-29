import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {runClaim} from "../build/claim-verb.ts";
import {CLAIM_NOT_MINE as BUILD_CLAIM_NOT_MINE} from "../build/codes.ts";
import {
	comments as buildComments,
	issue as buildIssue,
	LANE_UUID,
	NO_BLOCKERS,
	SIBLING_UUID,
	served,
	truncatedComments,
} from "../build/fixtures.test-support.ts";
import {
	fakeFs,
	fakeSeams,
	type HttpReply,
	type Scripted,
	unconfigured,
} from "../fakes.test-support.ts";
import {FAILED} from "../verb.ts";
import {runLaneAdopt, runLaneClaim, runLaneRelease} from "./claim-verb.ts";
import {APPEND_UNKNOWN, CLAIM_NOT_MINE, LANE_UNREADABLE, MARKER_READBACK} from "./codes.ts";
import {parseKey} from "./key.ts";

const COMMENTS = /^GET .*\/repos\/o\/r\/issues\/5492\/comments\?/;
const POST = /^POST .*\/repos\/o\/r\/issues\/5492\/comments$/;
const GET_COMMENT = /^GET .*\/repos\/o\/r\/issues\/comments\/9001$/;
const DELETE = /^DELETE .*\/repos\/o\/r\/issues\/comments\//;
const perm = (login: string) => new RegExp(`^GET .*/repos/o/r/collaborators/${login}/permission$`);

/** The request line a retraction shows up as — what a "which markers were deleted" claim reads. */
const deleted = (id: number) => `DELETE https://api.github.com/repos/o/r/issues/comments/${id}`;

const WRITE_PERMISSION: HttpReply = served({permission: "write"});
const GATEWAY: HttpReply = {status: 502, body: '{"message":"Bad gateway"}'};
const DELETED: HttpReply = {status: 204, body: ""};

const OTHER_UUID = "9d8c7b6a-5f4e-3d2c-1b0a-998877665544";

const laneMarker = (session: string, uuid: string): string =>
	`lane-claim: lane:${session}:${uuid} · 2026-08-17T00:00:00Z`;

const MINE = laneMarker("s-9f2e", LANE_UUID);
const THEIRS = laneMarker("s-77aa", OTHER_UUID);
/** A second driver of the SAME session — the two-lanes-one-session shape (#6060). */
const SIBLING = laneMarker("s-9f2e", SIBLING_UUID);

const MY_TOKEN = `lane:s-9f2e:${LANE_UUID}`;
const SIBLING_TOKEN = `lane:s-9f2e:${SIBLING_UUID}`;

const POSTED = served({id: 9001, html_url: "https://github.com/o/r/issues/5492#c"}, 201);
const ECHO = served({body: MINE});

const key = (raw: string) => {
	const parsed = parseKey(raw);
	if (parsed._tag === "Malformed") throw new Error(`fixture key "${raw}" is malformed`);
	return parsed.key;
};

const options = {
	key: key("5492"),
	lane: "5492",
	token: null as string | null,
	repo: null,
	cwd: "/repo",
	env: {CLAUDE_PIPELINE_REPO: "o/r", CLAUDE_CODE_SESSION_ID: "s-9f2e"} as Record<
		string,
		string | undefined
	>,
	uuid: LANE_UUID,
	at: "2026-08-17T00:00:00Z",
};

const run = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) =>
	Effect.runPromise(
		Effect.provide(
			runLaneClaim({...options, ...overrides}),
			Layer.merge(fakeSeams(script).layer, unconfigured),
		),
	);

const release = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) =>
	Effect.runPromise(
		Effect.provide(
			runLaneRelease({...options, ...overrides}),
			Layer.merge(fakeSeams(script).layer, unconfigured),
		),
	);

describe("runLaneClaim", () => {
	it("wins when its own marker is the earliest authorized one", async () => {
		const out = await run([
			[POST, POSTED],
			[GET_COMMENT, ECHO],
			[COMMENTS, buildComments({id: 9001, body: MINE})],
			[perm("agent"), WRITE_PERMISSION],
		]);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({
			answer: "won",
			lane: "5492",
			number: 5492,
			token: `lane:s-9f2e:${LANE_UUID}`,
		});
	});

	it("re-reads AFTER posting — the checkpoint is what resolves a staggered race", async () => {
		const seams = fakeSeams([
			[POST, POSTED],
			[GET_COMMENT, ECHO],
			[COMMENTS, buildComments({id: 9001, body: MINE})],
			[perm("agent"), WRITE_PERMISSION],
		]);
		await Effect.runPromise(Effect.provide(runLaneClaim(options), seams.layer));
		const posted = seams.requests.findIndex((line) => POST.test(line));
		const swept = seams.requests.findIndex((line) => COMMENTS.test(line));
		expect(posted).toBeGreaterThanOrEqual(0);
		expect(swept).toBeGreaterThan(posted);
	});

	it("exits 31 on a proven loss — never 0 — and retracts only its OWN marker", async () => {
		const seams = fakeSeams([
			[POST, POSTED],
			[GET_COMMENT, ECHO],
			[
				COMMENTS,
				buildComments(
					{id: 8000, body: THEIRS, createdAt: "2026-08-16T00:00:00Z"},
					{id: 9001, body: MINE, createdAt: "2026-08-17T00:00:00Z"},
				),
			],
			[perm("agent"), WRITE_PERMISSION],
			[DELETE, DELETED],
		]);
		const out = await Effect.runPromise(Effect.provide(runLaneClaim(options), seams.layer));
		expect(out.code).toBe(CLAIM_NOT_MINE);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain(`lane:s-77aa:${OTHER_UUID}`);
		const deletes = seams.requests.filter((line) => DELETE.test(line));
		expect(deletes).toEqual([deleted(9001)]);
	});

	/**
	 * A sibling driver of THIS session is a co-racer, not this run: ownership turns on the whole
	 * token, so the older marker wins and this run retracts its own rather than reading the
	 * neighbour's claim as its own (#6060).
	 */
	it("loses to a sibling driver of its own session, and says which one", async () => {
		const seams = fakeSeams([
			[POST, POSTED],
			[GET_COMMENT, ECHO],
			[
				COMMENTS,
				buildComments(
					{id: 8000, body: SIBLING, createdAt: "2026-08-16T00:00:00Z"},
					{id: 9001, body: MINE, createdAt: "2026-08-17T00:00:00Z"},
				),
			],
			[perm("agent"), WRITE_PERMISSION],
			[DELETE, DELETED],
		]);
		const out = await Effect.runPromise(Effect.provide(runLaneClaim(options), seams.layer));
		expect(out.code).toBe(CLAIM_NOT_MINE);
		expect(out.stderr.join("\n")).toContain(SIBLING_TOKEN);
		expect(seams.requests.filter((line) => DELETE.test(line))).toEqual([deleted(9001)]);
	});

	/**
	 * The UNKNOWN path retracts too. Its comment id is in hand and is provably this run's own write —
	 * the one write a loser may always make — and leaving it stranded is a marker no later run can
	 * resolve, on a namespace with no TTL to expire it (#6000).
	 */
	it("exits 11 on an unreadable marker set — UNKNOWN, never unclaimed — retracting its own", async () => {
		const seams = fakeSeams([
			[POST, POSTED],
			[GET_COMMENT, ECHO],
			[COMMENTS, truncatedComments({id: 9001, body: MINE})],
			[perm("agent"), WRITE_PERMISSION],
			[DELETE, DELETED],
		]);
		const out = await Effect.runPromise(Effect.provide(runLaneClaim(options), seams.layer));
		expect(out.code).toBe(LANE_UNREADABLE);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("UNKNOWN");
		expect(seams.requests.filter((line) => DELETE.test(line))).toEqual([deleted(9001)]);
	});

	it("exits 1 with no session id, and writes nothing", async () => {
		const seams = fakeSeams([]);
		const out = await Effect.runPromise(
			Effect.provide(runLaneClaim({...options, env: {CLAUDE_PIPELINE_REPO: "o/r"}}), seams.layer),
		);
		expect(out.code).toBe(FAILED);
		expect(seams.requests).toEqual([]);
	});

	it("exits 8 when the marker write fails — UNKNOWN, never a held lane", async () => {
		const out = await run([[POST, GATEWAY]]);
		expect(out.code).toBe(APPEND_UNKNOWN);
		expect(out.stdout).toBe("");
	});

	it("exits 9 when the marker lands and does not read back", async () => {
		const out = await run([
			[POST, POSTED],
			[GET_COMMENT, served({body: THEIRS})],
		]);
		expect(out.code).toBe(MARKER_READBACK);
		expect(out.stderr.join("\n")).toContain("9001");
	});

	it("answers unclaimable on a chore lane, writing nothing", async () => {
		const seams = fakeSeams([]);
		const out = await Effect.runPromise(
			Effect.provide(
				runLaneClaim({...options, key: key("chore:park-sweep"), lane: "chore:park-sweep"}),
				seams.layer,
			),
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).answer).toBe("unclaimable");
		expect(seams.requests).toEqual([]);
	});
});

describe("runLaneRelease", () => {
	it("retracts this driver's own marker", async () => {
		const seams = fakeSeams([
			[COMMENTS, buildComments({id: 9001, body: MINE})],
			[perm("agent"), WRITE_PERMISSION],
			[DELETE, DELETED],
		]);
		const out = await Effect.runPromise(
			Effect.provide(runLaneRelease({...options, token: MY_TOKEN}), seams.layer),
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({answer: "released", lane: "5492", number: 5492});
		expect(seams.requests).toContain(deleted(9001));
	});

	it("exits 31 rather than retracting another driver's marker", async () => {
		const seams = fakeSeams([
			[COMMENTS, buildComments({id: 8000, body: THEIRS})],
			[perm("agent"), WRITE_PERMISSION],
		]);
		const out = await Effect.runPromise(
			Effect.provide(runLaneRelease({...options, token: MY_TOKEN}), seams.layer),
		);
		expect(out.code).toBe(CLAIM_NOT_MINE);
		expect(seams.requests.filter((line) => DELETE.test(line))).toEqual([]);
	});

	/**
	 * The sharpest edge of the session-only rule: this release used to resolve `Mine` on a sibling
	 * driver's marker and delete it, which is unrecoverable and leaves the issue reading unclaimed
	 * (#6060). The refusal names the holding token so a reader can find the comment.
	 */
	it("refuses a sibling driver of its OWN session, naming the holding token", async () => {
		const seams = fakeSeams([
			[COMMENTS, buildComments({id: 8000, body: SIBLING})],
			[perm("agent"), WRITE_PERMISSION],
		]);
		const out = await Effect.runPromise(
			Effect.provide(runLaneRelease({...options, token: MY_TOKEN}), seams.layer),
		);
		expect(out.code).toBe(CLAIM_NOT_MINE);
		expect(out.stderr.join("\n")).toContain(SIBLING_TOKEN);
		expect(seams.requests.filter((line) => DELETE.test(line))).toEqual([]);
	});

	it("exits 1 with no --token on a board lane, and reads nothing", async () => {
		const seams = fakeSeams([]);
		const out = await Effect.runPromise(Effect.provide(runLaneRelease(options), seams.layer));
		expect(out.code).toBe(FAILED);
		expect(seams.requests).toEqual([]);
	});

	/** A read that failed is UNKNOWN, and an UNKNOWN holding never authorizes a delete. */
	it("exits 11 on an unreadable marker read, retracting nothing", async () => {
		const seams = fakeSeams([
			[COMMENTS, truncatedComments({id: 9001, body: MINE})],
			[perm("agent"), WRITE_PERMISSION],
		]);
		const out = await Effect.runPromise(
			Effect.provide(runLaneRelease({...options, token: MY_TOKEN}), seams.layer),
		);
		expect(out.code).toBe(LANE_UNREADABLE);
		expect(out.stderr.join("\n")).toContain("UNKNOWN");
		expect(seams.requests.filter((line) => DELETE.test(line))).toEqual([]);
	});

	it("exits 8 when the delete fails — whether the lane is still held is UNKNOWN", async () => {
		const seams = fakeSeams([
			[COMMENTS, buildComments({id: 9001, body: MINE})],
			[perm("agent"), WRITE_PERMISSION],
			[DELETE, GATEWAY],
		]);
		const out = await Effect.runPromise(
			Effect.provide(runLaneRelease({...options, token: MY_TOKEN}), seams.layer),
		);
		expect(out.code).toBe(APPEND_UNKNOWN);
		expect(out.stderr.join("\n")).toContain("UNKNOWN");
	});

	it("answers inert on a chore lane, which was never handed a token", async () => {
		const out = await release([], {key: key("chore:park-sweep"), lane: "chore:park-sweep"});
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).answer).toBe("inert");
	});
});

/**
 * The protocol's fixed point: one DRIVER, one marker, one token (#6087, scoped per driver by #6060).
 *
 * Before the guard, N claims left N markers and each release peeled one off — and since nothing in
 * this namespace expires a marker, the leftovers made the lane refuse on `31` for good.
 */
describe("one driver, one marker", () => {
	const held = (...bodies: ReadonlyArray<readonly [number, string]>) =>
		buildComments(...bodies.map(([id, body]) => ({id, body})));

	it("posts no second marker on a re-claim, and answers with the owning token", async () => {
		const seams = fakeSeams([
			[COMMENTS, held([9001, MINE])],
			[perm("agent"), WRITE_PERMISSION],
		]);
		const out = await Effect.runPromise(
			Effect.provide(runLaneClaim({...options, token: MY_TOKEN}), seams.layer),
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({
			answer: "won",
			lane: "5492",
			number: 5492,
			token: MY_TOKEN,
		});
		expect(seams.requests.filter((line) => POST.test(line))).toEqual([]);
	});

	/** Claim, re-claim, release once: no marker of this driver survives for a later claim to lose to. */
	it("leaves nothing behind after one release", async () => {
		const seams = fakeSeams([
			[COMMENTS, held([9001, MINE])],
			[perm("agent"), WRITE_PERMISSION],
			[DELETE, DELETED],
		]);
		await Effect.runPromise(
			Effect.provide(runLaneClaim({...options, token: MY_TOKEN}), seams.layer),
		);
		const out = await Effect.runPromise(
			Effect.provide(runLaneRelease({...options, token: MY_TOKEN}), seams.layer),
		);
		expect(out.code).toBe(0);
		expect(seams.requests.filter((line) => DELETE.test(line))).toEqual([deleted(9001)]);
	});

	/** A thread that already carries duplicates — written before the guard — is swept, not crashed on. */
	it("sweeps every marker carrying this driver's token, and only those", async () => {
		const seams = fakeSeams([
			[COMMENTS, held([9001, MINE], [9002, MINE], [9003, THEIRS])],
			[perm("agent"), WRITE_PERMISSION],
			[DELETE, DELETED],
		]);
		const out = await Effect.runPromise(
			Effect.provide(runLaneRelease({...options, token: MY_TOKEN}), seams.layer),
		);
		expect(out.code).toBe(0);
		expect(seams.requests.filter((line) => DELETE.test(line))).toEqual([
			deleted(9001),
			deleted(9002),
		]);
	});

	/** The claim and the release agree about the nonce, so neither can address the other's marker. */
	it("hands back a token release resolves as its own", async () => {
		const claimed = await run([
			[POST, POSTED],
			[GET_COMMENT, ECHO],
			[COMMENTS, buildComments({id: 9001, body: MINE})],
			[perm("agent"), WRITE_PERMISSION],
		]);
		const token = JSON.parse(claimed.stdout).token as string;
		const seams = fakeSeams([
			[COMMENTS, buildComments({id: 9001, body: MINE})],
			[perm("agent"), WRITE_PERMISSION],
			[DELETE, DELETED],
		]);
		const out = await Effect.runPromise(
			Effect.provide(runLaneRelease({...options, token}), seams.layer),
		);
		expect(out.code).toBe(0);
	});
});

describe("a driver's claim and the builder it spawns", () => {
	/**
	 * The collision this pair exists to prevent, and the one it must NOT create: the driver holds
	 * #5492 and the builder it spawns claims the same number and wins, because the two markers are
	 * two namespaces on one thread rather than one race with two entrants (#5761).
	 */
	it("lets the spawned builder claim the same issue and win", async () => {
		const BUILD_ISSUE = /^GET .*\/repos\/o\/r\/issues\/5492$/;
		const BUILD_COMMENTS = COMMENTS;
		const claimable = buildIssue({
			number: 5492,
			labels: [
				{name: "type:feature"},
				{name: "p1"},
				{name: "status:triaged"},
				{name: "ready-for:agent"},
			],
		});
		const buildMarker = `build-claim: build:s-b1:${OTHER_UUID} · 2026-08-17T00:10:00Z`;
		const out = await Effect.runPromise(
			Effect.provide(
				runClaim({
					number: 5492,
					issue: null,
					repo: null,
					cwd: "/repo",
					env: {CLAUDE_PIPELINE_REPO: "o/r", CLAUDE_CODE_SESSION_ID: "s-b1"},
					uuid: OTHER_UUID,
					token: null,
					at: "2026-08-17T00:10:00Z",
					purpose: "build",
					override: null,
					overrideLane: null,
					cites: null,
					resume: false,
				}),
				fakeSeams([
					[BUILD_ISSUE, claimable],
					[POST, served({id: 9002, html_url: "https://github.com/o/r#c"}, 201)],
					[/^GET .*\/repos\/o\/r\/issues\/comments\/9002$/, served({body: buildMarker})],
					[
						BUILD_COMMENTS,
						buildComments(
							// The driver's own claim, posted first and still held.
							{id: 9001, body: MINE, createdAt: "2026-08-17T00:00:00Z"},
							{id: 9002, body: buildMarker, createdAt: "2026-08-17T00:10:00Z"},
						),
					],
					[perm("agent"), WRITE_PERMISSION],
					NO_BLOCKERS,
				]).layer,
			).pipe(Effect.provide(fakeFs({files: {}}).layer)),
		);
		expect(out.code).not.toBe(BUILD_CLAIM_NOT_MINE);
		expect(JSON.parse(out.stdout).answer).toBe("won");
	});
});

/**
 * The killed-seat succession (ADR 0325, #6374). The stranded marker here is SAME-SESSION under
 * another nonce, which is what a killed operator seat actually leaves: the successor boots under the
 * one `CLAUDE_CODE_SESSION_ID` and only its nonce differs. That is the shape `build adopt` refuses
 * as already covered by plain release; here plain release reads it as foreign, so it is the case
 * this verb exists for.
 */
describe("runLaneAdopt", () => {
	const ADOPT_BODY = `lane-adopt: s-9f2e by ${MY_TOKEN} · 2026-08-17T00:00:00Z · reason: the seat was killed by an outage`;

	const adoptOptions = {
		key: options.key,
		lane: options.lane,
		repo: null,
		env: options.env,
		uuid: LANE_UUID,
		at: options.at,
		session: "s-9f2e",
		reason: "the seat was killed by an outage",
	};

	const adopt = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof adoptOptions> = {}) =>
		Effect.runPromise(
			Effect.provide(
				runLaneAdopt({...adoptOptions, ...overrides}),
				Layer.merge(fakeSeams(script).layer, unconfigured),
			),
		);

	it("posts one marker naming the stranded seat, and prints the successor token", async () => {
		const seams = fakeSeams([
			[POST, POSTED],
			[GET_COMMENT, served({body: ADOPT_BODY})],
		]);
		const out = await Effect.runPromise(Effect.provide(runLaneAdopt(adoptOptions), seams.layer));
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({
			answer: "adopted",
			lane: "5492",
			number: 5492,
			session: "s-9f2e",
			token: MY_TOKEN,
		});
		expect(seams.requests.filter((line) => POST.test(line))).toHaveLength(1);
	});

	it("exits 1 on an empty --session or --reason, writing nothing", async () => {
		for (const overrides of [{session: "  "}, {reason: ""}]) {
			const out = await adopt([], overrides);
			expect(out.code).toBe(FAILED);
			expect(out.stdout).toBe("");
		}
	});

	it("exits 1 on a --session carrying the marker's own field separator", async () => {
		const out = await adopt([], {session: "s-9f2e · s-other"});
		expect(out.code).toBe(FAILED);
	});

	it("exits 1 on a multi-line --reason, writing nothing", async () => {
		const seams = fakeSeams([]);
		const out = await Effect.runPromise(
			Effect.provide(
				runLaneAdopt({...adoptOptions, reason: "the seat was killed\nby an outage"}),
				Layer.merge(seams.layer, unconfigured),
			),
		);
		expect(out.code).toBe(FAILED);
		expect(out.stdout).toBe("");
		expect(seams.requests).toEqual([]);
	});

	it("answers inert on a chore lane, writing nothing", async () => {
		const seams = fakeSeams([]);
		const out = await Effect.runPromise(
			Effect.provide(
				runLaneAdopt({...adoptOptions, key: key("chore:sweep"), lane: "chore:sweep"}),
				seams.layer,
			),
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).answer).toBe("inert");
		expect(seams.requests).toEqual([]);
	});

	it("exits 9 when the marker lands and does not read back", async () => {
		const out = await adopt([
			[POST, POSTED],
			[GET_COMMENT, served({body: "lane-adopt: s-other by lane:s-9f2e:x · at · reason: no"})],
		]);
		expect(out.code).toBe(MARKER_READBACK);
	});

	it("makes the stranded same-session claim releasable, and takes the adopt with it", async () => {
		const seams = fakeSeams([
			[
				COMMENTS,
				buildComments(
					{id: 8000, body: SIBLING, createdAt: "2026-08-16T00:00:00Z"},
					{id: 9002, body: ADOPT_BODY, createdAt: "2026-08-17T00:00:00Z"},
				),
			],
			[perm("agent"), WRITE_PERMISSION],
			[DELETE, DELETED],
		]);
		const out = await Effect.runPromise(
			Effect.provide(runLaneRelease({...options, token: MY_TOKEN}), seams.layer),
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({
			answer: "released",
			lane: "5492",
			number: 5492,
			adopted: "s-9f2e",
		});
		expect(seams.requests.filter((line) => DELETE.test(line))).toEqual([
			deleted(8000),
			deleted(9002),
		]);
	});

	/**
	 * Answering `won` here would hand back the DEAD seat's token, which every later verb of this run
	 * refuses as another lane's. The successor's path is adopt → release → claim, and this refusal is
	 * what keeps it the only one.
	 */
	it("refuses a re-claim under an adopted claim rather than answering with the dead seat's token", async () => {
		const seams = fakeSeams([
			[
				COMMENTS,
				buildComments(
					{id: 8000, body: SIBLING, createdAt: "2026-08-16T00:00:00Z"},
					{id: 9002, body: ADOPT_BODY, createdAt: "2026-08-17T00:00:00Z"},
				),
			],
			[perm("agent"), WRITE_PERMISSION],
		]);
		const out = await Effect.runPromise(
			Effect.provide(runLaneClaim({...options, token: MY_TOKEN}), seams.layer),
		);
		expect(out.code).toBe(CLAIM_NOT_MINE);
		expect(out.stderr.join("\n")).toContain(SIBLING_TOKEN);
		expect(seams.requests.filter((line) => POST.test(line))).toEqual([]);
	});

	it("names the succession route on a proven loss, so claim and stale stop contradicting", async () => {
		const seams = fakeSeams([
			[POST, POSTED],
			[GET_COMMENT, ECHO],
			[
				COMMENTS,
				buildComments(
					{id: 8000, body: THEIRS, createdAt: "2026-08-16T00:00:00Z"},
					{id: 9001, body: MINE, createdAt: "2026-08-17T00:00:00Z"},
				),
			],
			[perm("agent"), WRITE_PERMISSION],
			[DELETE, DELETED],
		]);
		const out = await Effect.runPromise(Effect.provide(runLaneClaim(options), seams.layer));
		expect(out.code).toBe(CLAIM_NOT_MINE);
		expect(out.stderr.join("\n")).toContain("fabrika lane adopt 5492 --session s-77aa");
	});
});
