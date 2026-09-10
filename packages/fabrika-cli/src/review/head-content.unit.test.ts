/**
 * The one property this module exists for: `build verdicts` and `ship gate` cannot answer "is this
 * marker current at this head?" differently.
 *
 * Asserting each verb's own reading separately would prove neither — the defect this replaced was
 * two verbs each self-consistently reading a different rule. So every case here runs BOTH verbs over
 * the same marker, the same head and the same git answers, and compares their two answers to each
 * other before comparing either to an expectation.
 */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import * as build from "../build/fixtures.test-support.ts";
import {runVerdicts} from "../build/verdicts-verb.ts";
import {errOut, fakeSeams, okOut, type Scripted, unconfigured} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import * as ship from "../ship/fixtures.test-support.ts";
import {runGate} from "../ship/gate-verb.ts";

/** The digest of {@link RAW}, written out so the fixture cannot agree with the code by calling it. */
const DIGEST = "65ebe421b3c0";
const RAW = `:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} M\0apps/web/src/a.ts\0`;
const BASE = "0f1e2d3c4b5a69788796a5b4c3d2e1f009182736";
const BASE_TIP = "5a4b3c2d1e0f98877665544332211000ffeeddcc";

const MARKER = (sha: string, content: string | null): string =>
	`review-code: PASS @ ${sha}${content === null ? "" : ` content:${content}`} — the clause`;

/** The object-database walk `bindHead` + `contentDigestAt` make, for one PR number and head. */
const gitFor = (pr: number, head: string, raw: ExecResult): ReadonlyArray<Scripted> => [
	[
		/^git remote -v$/,
		okOut("origin\tgit@github.com:o/r.git (fetch)\norigin\tgit@github.com:o/r.git (push)\n"),
	],
	[new RegExp(`^git fetch --quiet origin pull/${pr}/head$`), okOut("")],
	[new RegExp(`^git rev-parse --verify --quiet ${head}\\^\\{commit\\}$`), okOut(`${head}\n`)],
	[/^git remote$/, okOut("origin\n")],
	[/^git fetch --quiet origin main$/, okOut("")],
	[/^git rev-parse --verify --quiet origin\/main\^\{commit\}$/, okOut(`${BASE_TIP}\n`)],
	[new RegExp(`^git merge-base ${BASE_TIP} ${head}$`), okOut(`${BASE}\n`)],
	[new RegExp(`^git diff .* --raw --abbrev=40 -z ${BASE}\\.\\.\\.${head}$`), raw],
];

/** `build verdicts`' answer for one marker: whether its row reads current. */
const verdictsSaysCurrent = async (markerBody: string, raw: ExecResult): Promise<boolean> => {
	const PR = 4310;
	const out = await Effect.runPromise(
		Effect.provide(
			runVerdicts({
				pr: PR,
				repo: null,
				env: {CLAUDE_PIPELINE_REPO: "o/r", ...build.GH_TOKEN_ENV},
			}),
			fakeSeams([
				[new RegExp(`^GET \\S+/repos/o/r/pulls/${PR}$`), build.pull({base: {ref: "main"}})],
				[
					new RegExp(`^GET \\S+/repos/o/r/issues/${PR}/comments`),
					build.comments({id: 1, body: markerBody}),
				],
				[new RegExp(`^GET \\S+/repos/o/r/pulls/${PR}/reviews`), build.served([])],
				[/^GET \S+\/repos\/o\/r\/issues\/4312$/, build.issue()],
				...gitFor(PR, build.HEAD, raw),
			]).layer,
		),
	);
	expect(out.code).toBe(0);
	const rows = JSON.parse(out.stdout).rows as ReadonlyArray<{gate: string; current: boolean}>;
	const row = rows.find((each) => each.gate === "review-code");
	expect(row).toBeDefined();
	return row?.current === true;
};

/** `ship gate`'s answer for the same marker: whether the namespace resolves anything but stale. */
const gateSaysCurrent = async (markerBody: string, raw: ExecResult): Promise<boolean> => {
	const PR = 4321;
	const out = await Effect.runPromise(
		Effect.provide(
			runGate({
				pr: PR,
				sha: ship.HEAD,
				require: ["review-code"],
				cp: false,
				repo: null,
				json: true,
				cwd: "/repo",
				env: ship.ENV,
			}),
			Layer.merge(
				fakeSeams([
					[
						new RegExp(`^GET \\S+/repos/o/r/pulls/${PR}$`),
						{status: 200, body: ship.pull({comments: 1, changedFiles: 1}).stdout},
					],
					[
						new RegExp(`^GET \\S+/repos/o/r/pulls/${PR}/files\\?`),
						{status: 200, body: ship.files("apps/site/src/a.ts").stdout},
					],
					[
						new RegExp(`^GET \\S+/repos/o/r/issues/${PR}/comments\\?`),
						{status: 200, body: ship.comments({id: 1, body: markerBody}).stdout},
					],
					[
						/^GET \S+\/repos\/o\/r\/collaborators\/[^/]+\/permission$/,
						{status: 200, body: JSON.stringify({permission: "write"})},
					],
					[
						new RegExp(`^GET https://api\\.github\\.com/repos/o/r/pulls/${PR}/reviews`),
						{status: 200, body: "[]"},
					],
					...gitFor(PR, ship.HEAD, raw),
				]).layer,
				unconfigured,
			),
		),
	);
	expect(out.code).toBe(0);
	const namespaces = JSON.parse(out.stdout).namespaces as ReadonlyArray<{
		name: string;
		state: string;
	}>;
	const found = namespaces.find((each) => each.name === "review-code");
	expect(found).toBeDefined();
	return found?.state !== "stale";
};

/** Both verbs, over the same marker shape, answered against each other. */
const agree = async (
	markerAt: (head: string) => string,
	raw: ExecResult,
): Promise<{verdicts: boolean; gate: boolean}> => {
	const verdicts = await verdictsSaysCurrent(markerAt(build.OLD_HEAD), raw);
	const gate = await gateSaysCurrent(markerAt(ship.OTHER_HEAD), raw);
	expect(verdicts).toBe(gate);
	return {verdicts, gate};
};

describe("build verdicts and ship gate resolve one marker's staleness identically", () => {
	it("the rebase case: a moved head whose content digest is still this head's reads current to both", async () => {
		const answers = await agree((head) => MARKER(head, DIGEST), okOut(RAW));
		expect(answers.verdicts).toBe(true);
	});

	it("the content-changed case: a differing digest reads stale to both", async () => {
		const answers = await agree((head) => MARKER(head, "ffffffffffff"), okOut(RAW));
		expect(answers.verdicts).toBe(false);
	});

	it("a marker carrying no content field falls back to head equality — stale to both", async () => {
		const answers = await agree((head) => MARKER(head, null), okOut(RAW));
		expect(answers.verdicts).toBe(false);
	});

	it("a digest neither verb could derive is Unbindable, and reads NOT current to both", async () => {
		const answers = await agree((head) => MARKER(head, DIGEST), errOut("no such ref"));
		expect(answers.verdicts).toBe(false);
	});

	// `ship gate`'s own no-git case is already pinned in its suite; this is the one `build verdicts`
	// gained, and it is the whole cost story — the common path must stay as cheap as it was.
	it("build verdicts reads no git when the marker is already at this head", async () => {
		const seams = fakeSeams([
			[/^GET \S+\/repos\/o\/r\/pulls\/4310$/, build.pull({base: {ref: "main"}})],
			[
				/^GET \S+\/repos\/o\/r\/issues\/4310\/comments/,
				build.comments({id: 1, body: MARKER(build.HEAD, DIGEST)}),
			],
			[/^GET \S+\/repos\/o\/r\/pulls\/4310\/reviews/, build.served([])],
			[/^GET \S+\/repos\/o\/r\/issues\/4312$/, build.issue()],
		]);
		const out = await Effect.runPromise(
			Effect.provide(
				runVerdicts({
					pr: 4310,
					repo: null,
					env: {CLAUDE_PIPELINE_REPO: "o/r", ...build.GH_TOKEN_ENV},
				}),
				seams.layer,
			),
		);
		const rows = JSON.parse(out.stdout).rows as ReadonlyArray<{gate: string; current: boolean}>;
		expect(rows.find((each) => each.gate === "review-code")?.current).toBe(true);
		expect(seams.calls.some((call) => call.startsWith("git "))).toBe(false);
	});
});
