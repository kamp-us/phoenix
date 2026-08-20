import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {GIT_DIRS, served} from "../build/fixtures.test-support.ts";
import {CONFIG_PATH} from "../config/document.ts";
import {errOut, fakeFs, fakeSeams, okOut, type Scripted} from "../fakes.test-support.ts";
import type {StdinRead} from "../io/stdin.ts";
import {runChild} from "./child-verb.ts";
import {
	BAD_SECTIONS,
	EMPTY_STDIN,
	LEAKED_PATH,
	LINK_UNPROVEN,
	MANIFEST_UNWRITTEN,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {bodyDigest} from "./digest.ts";
import {
	CLAIMED,
	childBody,
	childIssue,
	DEFAULT_LABELS,
	DIR,
	env,
	epic,
	labelSet,
	milestones,
	TOKEN,
} from "./fixtures.test-support.ts";
import {manifestPath, parseManifest, renderRunRecord, runJsonPath} from "./run.ts";

const CREATE = /^POST https:\/\/api\.github\.com\/repos\/o\/r\/issues$/;
const LINK = /^POST https:\/\/api\.github\.com\/repos\/o\/r\/issues\/4300\/sub_issues$/;
const READBACK = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/issues\/4301$/;
const SUBS = /^gh api --paginate repos\/o\/r\/issues\/4300\/sub_issues/;
const LABELS = /^gh api --paginate repos\/o\/r\/labels/;
const MILESTONES = /^gh api --paginate repos\/o\/r\/milestones/;

const MINTED_LABELS = ["type:feature", "p1", "status:planned", "ready-for:agent"];

/** Every child is born homed (#5969), so the shared options carry a milestone the fixture knows. */
const HOME = "fabrika campaign";
const LANE = "axis:pipeline-hardening";

const RUN_JSON = (cycleDoc: "present" | "absent" | "unknown" = "present") =>
	renderRunRecord({
		epic: 4300,
		run: "4300-c1a4d6f8",
		mode: "fresh",
		cycleDoc,
		bodyDigest: bodyDigest("An epic brief about the moderation queue.\n"),
	});

const CREATED = served({number: 4301, id: 90210});

const HAPPY: ReadonlyArray<Scripted> = [
	[/^gh api repos\/o\/r\/issues\/4300$/, epic()],
	[/^git rev-parse --path-format=absolute/, GIT_DIRS],
	...CLAIMED,
	[LABELS, labelSet(...DEFAULT_LABELS)],
	[MILESTONES, milestones([44, "fabrika campaign"])],
	[CREATE, CREATED],
	[LINK, served({})],
	[READBACK, childIssue({number: 4301, labels: MINTED_LABELS, milestone: HOME})],
	[SUBS, okOut(JSON.stringify([{number: 4301, id: 90210, state: "open", state_reason: null}]))],
];

const options = {
	number: 4300,
	title: "queue view: fate loader",
	type: "type:feature",
	priority: "p1",
	readyFor: "agent" as string | null,
	assignee: null as string | null,
	milestone: HOME as string | null,
	labels: [] as ReadonlyArray<string>,
	token: TOKEN,
	repo: null,
	env,
	cwd: DIR,
};

const run = (
	overrides: Partial<typeof options> = {},
	script: ReadonlyArray<Scripted> = HAPPY,
	files: Readonly<Record<string, string | null>> = {[runJsonPath(DIR)]: RUN_JSON()},
	body: string = childBody(),
) => {
	const shell = fakeSeams(script);
	const fs = fakeFs({files});
	const stdin: Effect.Effect<StdinRead> = Effect.succeed({_tag: "Text", text: body});
	return Effect.runPromise(
		Effect.provide(
			runChild({...options, ...overrides, stdin}),
			Layer.mergeAll(shell.layer, fs.layer),
		),
	).then((outcome) => ({
		outcome,
		written: fs.written,
		calls: shell.calls,
		requests: shell.requests,
		bodies: shell.bodies,
	}));
};

/** The JSON a matching request carried — where every write's fields travel now (ADR 0315). */
const sent = (
	run: {requests: ReadonlyArray<string>; bodies: ReadonlyArray<string>},
	pattern: RegExp,
): Record<string, unknown> => {
	const at = run.requests.findIndex((line) => pattern.test(line));
	return at < 0 ? {} : (JSON.parse(run.bodies[at] ?? "{}") as Record<string, unknown>);
};

describe("runChild", () => {
	it("mints, records, links, re-reads, and reports the OBSERVED result", async () => {
		const {outcome, written} = await run();
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toEqual({
			answer: "minted",
			epic: 4300,
			child: 4301,
			linked: true,
			observed: {labels: [...MINTED_LABELS].sort(), assignees: [], milestone: HOME},
			stories: [1, 2],
			containment: "flag",
		});
		expect(parseManifest(written.get(manifestPath(DIR)) ?? "")).toEqual([
			{
				number: 4301,
				id: 90210,
				title: "queue view: fate loader",
				type: "type:feature",
				priority: "p1",
				readyFor: "agent",
				stories: [1, 2],
				containment: "flag",
				linked: true,
				mintedThisRun: true,
			},
		]);
	});

	/**
	 * The whole reason the verb exists: v1's create hardcoded three labels with no pass-through and set
	 * no milestone, so a fourth required label could only land by a follow-up PATCH — and that PATCH
	 * opens a window in which the child exists with no `ready-for:` value at all.
	 */
	it("puts every birth attribute in the one POST", async () => {
		const minted = await run({milestone: "fabrika campaign", labels: ["fabrika"]}, [
			...HAPPY.filter(([pattern]) => pattern !== LABELS && pattern !== READBACK),
			[LABELS, labelSet(...DEFAULT_LABELS, "fabrika")],
			[
				READBACK,
				childIssue({
					number: 4301,
					labels: [...MINTED_LABELS, "fabrika"],
					milestone: "fabrika campaign",
				}),
			],
		]);
		expect(sent(minted, CREATE).labels).toEqual([...MINTED_LABELS, "fabrika"]);
		expect(sent(minted, CREATE).milestone).toBe(44);
		expect(minted.requests.some((line) => line.startsWith("PATCH "))).toBe(false);
	});

	it("links on the child's id, not its number", async () => {
		expect(sent(await run(), LINK).sub_issue_id).toBe(90210);
	});

	/** #4780: a child must never inherit its audience by omission. */
	it("refuses an absent --ready-for before it reads anything", async () => {
		const {outcome, calls} = await run({readyFor: null});
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stderr.at(-1)).toBe(
			"ledger child: --ready-for is required — a child must never inherit its audience by omission (#4780).",
		);
		expect(calls).toEqual([]);
	});

	/** #4693: the label is the routing signal, born-assignment is the enforced hold. */
	it("refuses --ready-for human without --assignee", async () => {
		const {outcome} = await run({readyFor: "human"});
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stderr.at(-1)).toBe(
			"ledger child: --ready-for human requires --assignee — a held child is born assigned (#4693).",
		);
	});

	/**
	 * #5969: a child with neither an open milestone nor a standing lane is refused by the claim fence
	 * at exit 20, so it can never be built. The three cases are the whole homing axis.
	 */
	it("refuses a homeless child before it reads anything, naming both remedies", async () => {
		const {outcome, calls} = await run({milestone: null});
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stderr.at(-1)).toBe(
			"ledger child: a child needs a home — pass --milestone <open milestone title>, or --label the child with the parent's standing lane (wayfinder:backlog, axis:pipeline-hardening). A homeless child is refused at the claim fence, so it can never be built (#5969).",
		);
		expect(calls).toEqual([]);
	});

	it("mints a milestone-homed child", async () => {
		const minted = await run({milestone: HOME});
		expect(minted.outcome.code).toBe(0);
		expect(sent(minted, CREATE).milestone).toBe(44);
	});

	/** ADR 0208's lane exemption holds here too — homing is never collapsed into "milestone required". */
	it("mints a lane-homed child carrying no milestone", async () => {
		const minted = await run({milestone: null, labels: [LANE]}, [
			...HAPPY.filter(([pattern]) => pattern !== LABELS && pattern !== READBACK),
			[LABELS, labelSet(...DEFAULT_LABELS, LANE)],
			[READBACK, childIssue({number: 4301, labels: [...MINTED_LABELS, LANE]})],
		]);
		expect(minted.outcome.code).toBe(0);
		expect(JSON.parse(minted.outcome.stdout).observed.milestone).toBe(null);
		expect(sent(minted, CREATE).labels).toContain(LANE);
		expect(sent(minted, CREATE)).not.toHaveProperty("milestone");
		expect(minted.calls.some((line) => MILESTONES.test(line))).toBe(false);
	});

	it("refuses a retired priority", async () => {
		const {outcome} = await run({priority: "p3"});
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stderr.at(-1)).toContain("off the closed set (p0, p1, p2)");
	});

	/** #4285: `POST .../labels` CREATES an unknown label rather than rejecting it. */
	it("refuses a label absent from the repo taxonomy rather than minting it", async () => {
		const {outcome, calls} = await run({labels: ["not-a-label"]});
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stderr.at(-1)).toBe(
			'ledger child: label "not-a-label" is absent from o/r\'s taxonomy — refusing to create it (#4285).',
		);
		expect(calls.some((line) => CREATE.test(line))).toBe(false);
	});

	it("refuses a milestone that is not open in the repo", async () => {
		const {outcome} = await run({milestone: "Geçit"});
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stderr.at(-1)).toBe(
			'ledger child: milestone "Geçit" is not an open milestone of o/r.',
		);
	});

	it("refuses a body whose acceptance criteria are absent", async () => {
		const {outcome} = await run({}, HAPPY, {[runJsonPath(DIR)]: RUN_JSON()}, "**TDD:** yes\n");
		expect(outcome.code).toBe(BAD_SECTIONS);
	});

	it("refuses a type:feature child with no containment while the cycle doc is present", async () => {
		const {outcome} = await run(
			{},
			HAPPY,
			{[runJsonPath(DIR)]: RUN_JSON()},
			childBody({containment: null}),
		);
		expect(outcome.code).toBe(BAD_SECTIONS);
		expect(outcome.stderr.at(-1)).toContain("needs **Containment:** flag or exempt");
	});

	/**
	 * Story 5 of #5631: phoenix's pair is the shipped default, and a repo that declares another gets
	 * that one. The arm above is the bare-repo half — it writes no config at all.
	 */
	it("names the repo's own values in the refusal, off the resolved vocabulary", async () => {
		const {outcome} = await run(
			{},
			HAPPY,
			{
				[runJsonPath(DIR)]: RUN_JSON(),
				[`${DIR}/${CONFIG_PATH}`]:
					'{"containmentVocabulary": {"values": ["unpublished", "exempt"]}}',
			},
			childBody({containment: null}),
		);
		expect(outcome.code).toBe(BAD_SECTIONS);
		expect(outcome.stderr.at(-1)).toContain("needs **Containment:** unpublished or exempt");
	});

	it("admits a marker the repo's vocabulary carries and phoenix's does not", async () => {
		const {outcome} = await run(
			{},
			HAPPY,
			{
				[runJsonPath(DIR)]: RUN_JSON(),
				[`${DIR}/${CONFIG_PATH}`]: '{"containmentVocabulary": {"values": ["unpublished"]}}',
			},
			childBody({containment: "unpublished"}),
		);
		expect(outcome.code).toBe(0);
	});

	it("asks nothing of any child on an empty vocabulary", async () => {
		const {outcome} = await run(
			{},
			HAPPY,
			{
				[runJsonPath(DIR)]: RUN_JSON(),
				[`${DIR}/${CONFIG_PATH}`]: '{"containmentVocabulary": {"types": []}}',
			},
			childBody({containment: null}),
		);
		expect(outcome.code).toBe(0);
	});

	it("refuses on 11 when the config exists and its vocabulary does not decode", async () => {
		const {outcome} = await run({}, HAPPY, {
			[runJsonPath(DIR)]: RUN_JSON(),
			[`${DIR}/${CONFIG_PATH}`]: '{"containmentVocabulary": {"values": ["none"]}}',
		});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
	});

	it("drops the containment line when the run's cycle-doc read is absent", async () => {
		const minted = await run({}, HAPPY, {[runJsonPath(DIR)]: RUN_JSON("absent")});
		expect(String(sent(minted, CREATE).body)).not.toContain("**Containment:**");
	});

	it("refuses an empty pipe on its own code", async () => {
		const {outcome} = await run({}, HAPPY, {[runJsonPath(DIR)]: RUN_JSON()}, "  \n");
		expect(outcome.code).toBe(EMPTY_STDIN);
	});

	it("refuses a machine-local path in the child body", async () => {
		const {outcome} = await run(
			{},
			HAPPY,
			{[runJsonPath(DIR)]: RUN_JSON()},
			childBody().replace("The queue view", "See /Users/someone/plan.md"),
		);
		expect(outcome.code).toBe(LEAKED_PATH);
	});

	it("refuses when a precondition read fails, and creates nothing", async () => {
		const {outcome, calls} = await run({}, [
			...HAPPY.filter(([pattern]) => pattern !== LABELS),
			[LABELS, errOut("gh: Bad Gateway (HTTP 502)")],
		]);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(calls.some((line) => CREATE.test(line))).toBe(false);
	});

	it("seats a create that could not be proven on 8", async () => {
		const {outcome} = await run({}, [
			...HAPPY.filter(([pattern]) => pattern !== CREATE),
			[CREATE, errOut("gh: Bad Gateway (HTTP 502)")],
		]);
		expect(outcome.code).toBe(WRITE_UNKNOWN);
	});

	/**
	 * The manifest append sits BEFORE the link: a `23` must leave a child a successor can find and
	 * name. Under the reverse order the issue exists on GitHub, is absent from the manifest, and can
	 * be neither placed nor retired.
	 */
	it("records the child before it links, so a 23 leaves a findable number", async () => {
		const {outcome, written} = await run({}, [
			...HAPPY.filter(([pattern]) => pattern !== LINK),
			[LINK, errOut("gh: Unprocessable (HTTP 422)")],
		]);
		expect(outcome.code).toBe(LINK_UNPROVEN);
		expect(outcome.stderr.at(-1)).toContain("recorded in the run manifest as linked:false");
		expect(parseManifest(written.get(manifestPath(DIR)) ?? "")).toMatchObject([
			{number: 4301, id: 90210, linked: false},
		]);
	});

	it("seats an unprovable link on 23 even when the write itself returned", async () => {
		const {outcome} = await run({}, [
			...HAPPY.filter(([pattern]) => pattern !== SUBS),
			[SUBS, okOut("[]")],
		]);
		expect(outcome.code).toBe(LINK_UNPROVEN);
	});

	it("seats a create it cannot re-read on 8", async () => {
		const {outcome} = await run({}, [
			...HAPPY.filter(([pattern]) => pattern !== READBACK),
			[READBACK, errOut("gh: Bad Gateway (HTTP 502)")],
		]);
		expect(outcome.code).toBe(WRITE_UNKNOWN);
	});

	/** The observed labels decide, never the intent the write was issued with. */
	it("refuses when the child does not read back as sent", async () => {
		const {outcome} = await run({}, [
			...HAPPY.filter(([pattern]) => pattern !== READBACK),
			[READBACK, childIssue({number: 4301, labels: ["type:feature", "p1"]})],
		]);
		expect(outcome.code).toBe(READBACK_MISMATCH);
	});

	it("seats a manifest it could not write on 26, naming the number that now exists", async () => {
		const shell = fakeSeams(HAPPY);
		const fs = fakeFs({
			files: {[runJsonPath(DIR)]: RUN_JSON()},
			unwritable: [manifestPath(DIR)],
		});
		const outcome = await Effect.runPromise(
			Effect.provide(
				runChild({
					...options,
					stdin: Effect.succeed({_tag: "Text", text: childBody()} as StdinRead),
				}),
				Layer.mergeAll(shell.layer, fs.layer),
			),
		);
		expect(outcome.code).toBe(MANIFEST_UNWRITTEN);
		expect(outcome.stderr.at(-1)).toContain("created #4301");
	});

	it("refuses when the run directory holds no run.json", async () => {
		const {outcome} = await run({}, HAPPY, {});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
	});
});
