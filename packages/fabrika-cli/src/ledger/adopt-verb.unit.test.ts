import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {GATEWAY, GIT_DIRS, NOT_FOUND, served} from "../build/fixtures.test-support.ts";
import {fakeFs, fakeSeams, once, type Scripted} from "../fakes.test-support.ts";
import {compose} from "../report/amend.ts";
import {runAdopt} from "./adopt-verb.ts";
import {amendmentSection} from "./adoption.ts";
import {
	BAD_SECTIONS,
	LINK_UNPROVEN,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {bodyDigest} from "./digest.ts";
import {CLAIMED, DEFAULT_LABELS, DIR, env, epic, labelSet, TOKEN} from "./fixtures.test-support.ts";
import {manifestPath, parseManifest, renderRunRecord, runJsonPath} from "./run.ts";

const CHILD = 8195;
const CHILD_ID = 8_195_000;
const NOW = new Date("2026-09-26T12:00:00Z");

const EPIC_READ = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/issues\/4300$/;
const ADOPTEE = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/issues\/8195$/;
const PARENT = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/issues\/8195\/parent$/;
const PATCH = /^PATCH https:\/\/api\.github\.com\/repos\/o\/r\/issues\/8195$/;
const LINK = /^POST https:\/\/api\.github\.com\/repos\/o\/r\/issues\/4300\/sub_issues$/;
const SUBS = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/issues\/4300\/sub_issues\?/;
const TAXONOMY = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/labels\?/;
const ADD_LABEL = /^POST https:\/\/api\.github\.com\/repos\/o\/r\/issues\/8195\/labels$/;
const REMOVE_LABEL = /^DELETE https:\/\/api\.github\.com\/repos\/o\/r\/issues\/8195\/labels\//;

/** A report filed and triaged long before any plan: its own criteria, and no plan field lines. */
const REPORT = [
	"## Summary",
	"",
	"The pinned runtime cannot launch background children.",
	"",
	"### Acceptance criteria",
	"- [ ] a background child launches under the pinned runtime",
	"",
].join("\n");

const LABELS = ["type:bug", "p1", "status:triaged", "ready-for:agent"];
/** The same issue once adoption has parked it where a minted child is born. */
const PARKED = ["type:bug", "p1", "status:planned", "ready-for:agent"];

const adoptee = (body: string, labels: ReadonlyArray<string> = LABELS, extra = {}) =>
	served({
		number: CHILD,
		id: CHILD_ID,
		title: "the pinned runtime cannot launch background children",
		body,
		state: "open",
		state_reason: null,
		labels: labels.map((name) => ({name})),
		assignees: [],
		milestone: null,
		html_url: `https://forge.example/o/r/issues/${CHILD}`,
		...extra,
	});

const amended = (fields: ReadonlyArray<string>) =>
	compose(REPORT, amendmentSection(4300, fields), NOW).body;

const RUN_JSON = (cycleDoc: "present" | "absent" | "unknown" = "absent") =>
	renderRunRecord({
		epic: 4300,
		run: "4300-c1a4d6f8",
		mode: "fresh",
		cycleDoc,
		bodyDigest: bodyDigest("An epic brief about the moderation queue.\n"),
	});

const GROUND: ReadonlyArray<Scripted> = [
	[EPIC_READ, epic()],
	[/^git rev-parse --path-format=absolute/, GIT_DIRS],
	...CLAIMED,
];

const LINKED = served([{number: CHILD, id: CHILD_ID, state: "open", state_reason: null}]);

/** The label writes that move a triaged adoptee onto `status:planned`, add before remove. */
const PARK: ReadonlyArray<Scripted> = [
	[TAXONOMY, labelSet(...DEFAULT_LABELS)],
	[ADD_LABEL, served([])],
	[REMOVE_LABEL, served([])],
];

/** A triaged report with no field lines, adopted with `--stories 2`: amend, park, record, link, prove. */
const AMEND = (): ReadonlyArray<Scripted> => [
	...GROUND,
	[once(ADOPTEE), adoptee(REPORT)],
	[ADOPTEE, adoptee(amended(["**Stories:** 2"]), PARKED)],
	[PARENT, NOT_FOUND],
	[PATCH, served({})],
	...PARK,
	[LINK, served({})],
	[SUBS, LINKED],
];

const options = {
	number: 4300,
	child: CHILD,
	stories: "2" as string | null,
	containment: null as string | null,
	token: TOKEN,
	repo: null,
	env,
	cwd: DIR,
	now: () => NOW,
};

const run = (
	overrides: Partial<typeof options> = {},
	script: ReadonlyArray<Scripted> = AMEND(),
	files: Readonly<Record<string, string | null>> = {
		[runJsonPath(DIR)]: RUN_JSON(),
		[manifestPath(DIR)]: "",
	},
) => {
	const shell = fakeSeams(script);
	const fs = fakeFs({files});
	return Effect.runPromise(
		Effect.provide(runAdopt({...options, ...overrides}), Layer.mergeAll(shell.layer, fs.layer)),
	).then((outcome) => ({
		outcome,
		manifest: parseManifest(fs.written.get(manifestPath(DIR)) ?? "") ?? [],
		wroteManifest: fs.written.has(manifestPath(DIR)),
		requests: shell.requests,
		bodies: shell.bodies,
	}));
};

const sentBody = (result: {requests: ReadonlyArray<string>; bodies: ReadonlyArray<string>}) => {
	const at = result.requests.findIndex((line) => PATCH.test(line));
	return at < 0 ? null : (JSON.parse(result.bodies[at] ?? "{}") as {body: string}).body;
};

const writes = (requests: ReadonlyArray<string>) =>
	requests.filter((line) => !line.startsWith("GET "));

describe("runAdopt", () => {
	it("adopts a conforming issue without touching its body, and records and links it", async () => {
		const body = `**Stories:** 2\n\n${REPORT}`;
		const result = await run({}, [
			...GROUND,
			[once(ADOPTEE), adoptee(body)],
			[ADOPTEE, adoptee(body, PARKED)],
			[PARENT, NOT_FOUND],
			...PARK,
			[LINK, served({})],
			[SUBS, LINKED],
		]);
		expect(result.outcome.code).toBe(0);
		expect(JSON.parse(result.outcome.stdout)).toEqual({
			answer: "adopted",
			epic: 4300,
			child: CHILD,
			linked: true,
			link: "written",
			amended: false,
			park: "written",
			fields: [],
			stories: [2],
			containment: null,
		});
		expect(sentBody(result)).toBeNull();
		expect(result.manifest).toEqual([
			{
				number: CHILD,
				id: CHILD_ID,
				title: "the pinned runtime cannot launch background children",
				type: "type:bug",
				priority: "p1",
				readyFor: "ready-for:agent",
				stories: [2],
				containment: null,
				linked: true,
				mintedThisRun: false,
			},
		]);
	});

	it("links on the issue's id, never mints, and parks it on status:planned before it links", async () => {
		const result = await run();
		const at = result.requests.findIndex((line) => LINK.test(line));
		expect(JSON.parse(result.bodies[at] ?? "{}")).toEqual({sub_issue_id: CHILD_ID});
		const added = result.requests.findIndex((line) => ADD_LABEL.test(line));
		expect(JSON.parse(result.bodies[added] ?? "{}")).toEqual({labels: ["status:planned"]});
		expect(writes(result.requests)).toEqual([
			"PATCH https://api.github.com/repos/o/r/issues/8195",
			"POST https://api.github.com/repos/o/r/issues/8195/labels",
			"DELETE https://api.github.com/repos/o/r/issues/8195/labels/status%3Atriaged",
			"POST https://api.github.com/repos/o/r/issues/4300/sub_issues",
		]);
	});

	it("finishes a park caught mid-write by removing status:triaged only", async () => {
		const body = `**Stories:** 2\n\n${REPORT}`;
		const result = await run({}, [
			...GROUND,
			[once(ADOPTEE), adoptee(body, [...PARKED, "status:triaged"])],
			[ADOPTEE, adoptee(body, PARKED)],
			[PARENT, NOT_FOUND],
			[REMOVE_LABEL, served([])],
			[LINK, served({})],
			[SUBS, LINKED],
		]);
		expect(result.outcome.code).toBe(0);
		expect(writes(result.requests)).toEqual([
			"DELETE https://api.github.com/repos/o/r/issues/8195/labels/status%3Atriaged",
			"POST https://api.github.com/repos/o/r/issues/4300/sub_issues",
		]);
	});

	it("reports an unprovable park as UNKNOWN and never links a pickable issue", async () => {
		const body = `**Stories:** 2\n\n${REPORT}`;
		const result = await run({}, [
			...GROUND,
			[ADOPTEE, adoptee(body)],
			[PARENT, NOT_FOUND],
			[TAXONOMY, labelSet(...DEFAULT_LABELS)],
			[ADD_LABEL, served([])],
			[REMOVE_LABEL, GATEWAY],
		]);
		expect(result.outcome.code).toBe(WRITE_UNKNOWN);
		expect(result.outcome.stderr.join("\n")).toContain("re-run the same `ledger adopt`");
		expect(result.requests.some((line) => LINK.test(line))).toBe(false);
		expect(result.wroteManifest).toBe(false);
	});

	it("refuses to mint status:planned when the repo's taxonomy lacks it, before any write", async () => {
		const result = await run({}, [
			...GROUND,
			[ADOPTEE, adoptee(REPORT)],
			[PARENT, NOT_FOUND],
			[TAXONOMY, labelSet("type:bug", "p1", "status:triaged", "ready-for:agent")],
		]);
		expect(result.outcome.code).toBe(OFF_VOCABULARY);
		expect(result.outcome.stderr.at(-1)).toContain('label "status:planned" is absent');
		expect(writes(result.requests)).toEqual([]);
	});

	it("refuses an issue on a status the plan flip could not restore", async () => {
		const result = await run({}, [
			...GROUND,
			[ADOPTEE, adoptee(REPORT, ["type:bug", "p1", "status:needs-info", "ready-for:agent"])],
			[PARENT, NOT_FOUND],
		]);
		expect(result.outcome.code).toBe(OFF_VOCABULARY);
		expect(result.outcome.stderr.at(-1)).toContain("it carries status:needs-info");
		expect(writes(result.requests)).toEqual([]);
	});

	it("appends only the owed field line under a dated amendment, keeping the report byte for byte", async () => {
		const result = await run();
		expect(result.outcome.code).toBe(0);
		const body = sentBody(result) ?? "";
		expect(body.startsWith(REPORT.trimEnd())).toBe(true);
		expect(body.slice(REPORT.trimEnd().length)).toBe(
			"\n\n---\n\n## Amendment — 2026-09-26\n\nAdopted as a child of #4300 by `ledger adopt`.\n\n**Stories:** 2\n",
		);
		expect(JSON.parse(result.outcome.stdout)).toMatchObject({
			amended: true,
			fields: ["**Stories:** 2"],
		});
	});

	it("refuses an issue with no Stories line and no --stories before any write", async () => {
		const result = await run({stories: null});
		expect(result.outcome.code).toBe(BAD_SECTIONS);
		expect(result.outcome.stderr.at(-1)).toBe(
			"ledger adopt: #8195 cannot be adopted: it declares no **Stories:** line — pass --stories with the plan's story ids, or none.",
		);
		expect(writes(result.requests)).toEqual([]);
		expect(result.wroteManifest).toBe(false);
	});

	it("refuses a --stories value that differs from the one the issue declares — it never rewrites", async () => {
		const result = await run({stories: "3"}, [
			...GROUND,
			[ADOPTEE, adoptee(`**Stories:** 2\n\n${REPORT}`)],
			[PARENT, NOT_FOUND],
		]);
		expect(result.outcome.code).toBe(BAD_SECTIONS);
		expect(result.outcome.stderr.at(-1)).toContain("already declares **Stories:** 2, not 3");
		expect(writes(result.requests)).toEqual([]);
	});

	it("refuses an issue with no acceptance criteria — adoption cannot author them", async () => {
		const result = await run({}, [
			...GROUND,
			[ADOPTEE, adoptee("## Summary\n\nJust a report.\n")],
			[PARENT, NOT_FOUND],
		]);
		expect(result.outcome.code).toBe(BAD_SECTIONS);
		expect(writes(result.requests)).toEqual([]);
	});

	it("asks for --containment on an asked type while the cycle doc is present, then appends it", async () => {
		const files = {[runJsonPath(DIR)]: RUN_JSON("present"), [manifestPath(DIR)]: ""};
		const feature = ["type:feature", "p1", "status:triaged", "ready-for:agent"];
		const refused = await run(
			{},
			[...GROUND, [ADOPTEE, adoptee(REPORT, feature)], [PARENT, NOT_FOUND]],
			files,
		);
		expect(refused.outcome.code).toBe(BAD_SECTIONS);
		expect(refused.outcome.stderr.at(-1)).toContain("pass --containment flag or exempt");

		const fields = ["**Stories:** 2", "**Containment:** flag (default-off)"];
		const adopted = await run(
			{containment: "flag (default-off)"},
			[
				...GROUND,
				[once(ADOPTEE), adoptee(REPORT, feature)],
				[
					ADOPTEE,
					adoptee(amended(fields), ["type:feature", "p1", "status:planned", "ready-for:agent"]),
				],
				[PARENT, NOT_FOUND],
				[PATCH, served({})],
				...PARK,
				[LINK, served({})],
				[SUBS, LINKED],
			],
			files,
		);
		expect(adopted.outcome.code).toBe(0);
		expect(JSON.parse(adopted.outcome.stdout)).toMatchObject({fields, containment: "flag"});
	});

	it("repeats cleanly: no second amendment, no second link, one manifest line", async () => {
		const first = await run();
		expect(first.outcome.code).toBe(0);
		const again = await run(
			{},
			[
				...GROUND,
				[ADOPTEE, adoptee(amended(["**Stories:** 2"]), PARKED)],
				[PARENT, served({number: 4300})],
				[SUBS, LINKED],
			],
			{
				[runJsonPath(DIR)]: RUN_JSON(),
				[manifestPath(DIR)]: `${JSON.stringify(first.manifest[0])}\n`,
			},
		);
		expect(again.outcome.code).toBe(0);
		expect(JSON.parse(again.outcome.stdout)).toMatchObject({
			link: "already",
			amended: false,
			park: "already",
		});
		expect(writes(again.requests)).toEqual([]);
		expect(again.manifest).toEqual(first.manifest);
	});

	it("refuses an issue already parented by another epic", async () => {
		const result = await run({}, [
			...GROUND,
			[ADOPTEE, adoptee(REPORT)],
			[PARENT, served({number: 5000})],
		]);
		expect(result.outcome.code).toBe(OFF_VOCABULARY);
		expect(result.outcome.stderr.at(-1)).toContain("already a sub-issue of #5000");
		expect(writes(result.requests)).toEqual([]);
	});

	it("refuses an untriaged issue", async () => {
		const result = await run({}, [
			...GROUND,
			[ADOPTEE, adoptee(REPORT, ["type:bug", "p1", "status:needs-triage"])],
			[PARENT, NOT_FOUND],
		]);
		expect(result.outcome.code).toBe(OFF_VOCABULARY);
		expect(writes(result.requests)).toEqual([]);
	});

	it("writes nothing when the issue cannot be read", async () => {
		const result = await run({}, [...GROUND, [ADOPTEE, GATEWAY]]);
		expect(result.outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(writes(result.requests)).toEqual([]);
		expect(result.wroteManifest).toBe(false);
	});

	it("reports an unprovable amendment as UNKNOWN and goes no further", async () => {
		const result = await run({}, [
			...GROUND,
			[ADOPTEE, adoptee(REPORT)],
			[PARENT, NOT_FOUND],
			...PARK,
			[PATCH, GATEWAY],
		]);
		expect(result.outcome.code).toBe(WRITE_UNKNOWN);
		expect(result.outcome.stderr.at(-1)).toContain("re-run the same `ledger adopt`");
		expect(result.requests.some((line) => LINK.test(line) || ADD_LABEL.test(line))).toBe(false);
		expect(result.wroteManifest).toBe(false);
	});

	it("refuses an amendment that lands without the prior body", async () => {
		const result = await run({}, [
			...GROUND,
			[once(ADOPTEE), adoptee(REPORT)],
			[ADOPTEE, adoptee("**Stories:** 2\n")],
			[PARENT, NOT_FOUND],
			[PATCH, served({})],
			...PARK,
		]);
		expect(result.outcome.code).toBe(READBACK_MISMATCH);
		expect(result.requests.some((line) => LINK.test(line) || ADD_LABEL.test(line))).toBe(false);
	});

	it("records linked:false on an unproven link, and a re-run finishes it", async () => {
		const failed = await run({}, [
			...GROUND,
			[once(ADOPTEE), adoptee(REPORT)],
			[ADOPTEE, adoptee(amended(["**Stories:** 2"]), PARKED)],
			[PARENT, NOT_FOUND],
			[PATCH, served({})],
			...PARK,
			[LINK, GATEWAY],
		]);
		expect(failed.outcome.code).toBe(LINK_UNPROVEN);
		expect(failed.manifest.map((record) => record.linked)).toEqual([false]);

		const finished = await run(
			{},
			[
				...GROUND,
				[ADOPTEE, adoptee(amended(["**Stories:** 2"]), PARKED)],
				[PARENT, NOT_FOUND],
				[LINK, served({})],
				[SUBS, LINKED],
			],
			{
				[runJsonPath(DIR)]: RUN_JSON(),
				[manifestPath(DIR)]: `${JSON.stringify(failed.manifest[0])}\n`,
			},
		);
		expect(finished.outcome.code).toBe(0);
		expect(sentBody(finished)).toBeNull();
		expect(finished.manifest.map((record) => [record.number, record.linked])).toEqual([
			[CHILD, true],
		]);
	});

	it("refuses --child naming the epic before reading anything", async () => {
		const result = await run({child: 4300});
		expect(result.outcome.code).toBe(OFF_VOCABULARY);
		expect(result.requests).toEqual([]);
	});
});
