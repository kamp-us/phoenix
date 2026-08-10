import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut, once} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import type {StdinRead} from "../io/stdin.ts";
import {
	ALREADY_DESCOPED,
	BARE_AT_PATH,
	EMPTY_STDIN,
	LEAKED_PATH,
	MAP_AMBIGUOUS,
	NO_TARGET,
	NOT_FOG,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {issueJson, MAP_BODY, MAP_BODY_WITH_REJECTION, REPO} from "./fixtures.test-support.ts";
import {runOpen} from "./open-verb.ts";

const LABELS = /repos\/o\/r\/labels/;
const OPEN_MAPS = /issues\?state=open&labels=/;
const SEARCH = /search\/issues/;
const CREATE = /--method POST repos\/o\/r\/issues -f/;
const ADD_LABEL = /--method POST repos\/o\/r\/issues\/9140\/labels/;
const NEW_MAP = /issues\/9140$/;
const EXISTING_MAP = /issues\/9200$/;

const QUESTIONS = "does a suspended account keep its weight?\nwhat clock does weight decay on?\n";

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	stdin: StdinRead = {_tag: "Text", text: QUESTIONS},
	destination = "how moderation weight is earned",
) =>
	Effect.runPromise(
		Effect.provide(
			runOpen({
				destination,
				repo: null,
				env: {CLAUDE_PIPELINE_REPO: REPO},
				stdin: Effect.succeed(stdin),
			}),
			fakeShell(script).layer,
		),
	);

const labelsOk = [LABELS, okOut("wayfinding:map\nstatus:needs-triage")] as const;
const noMaps = [OPEN_MAPS, okOut("")] as const;
const noHits = [SEARCH, okOut("")] as const;
const minted = issueJson({number: 9140, body: "", labels: ["wayfinding:map"]});

describe("runOpen — the checks before it mints", () => {
	it("exits 3 with nothing on stdout when stdin held no question", async () => {
		const out = await run([labelsOk], {_tag: "Text", text: "  \n\n"});
		expect(out.code).toBe(EMPTY_STDIN);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("is not fog");
	});

	it("exits 17 when nothing supplied is stated as a question — the checkable half of the fog test", async () => {
		const out = await run([labelsOk], {_tag: "Text", text: "build the invite acceptance form\n"});
		expect(out.code).toBe(NOT_FOG);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("belongs in intake");
	});

	it("exits 5 on a machine-local path, unconditionally — no map verb offers --redact", async () => {
		const out = await run([labelsOk], {_tag: "Text", text: "does ~/notes/weight.md say?\n"});
		expect(out.code).toBe(LEAKED_PATH);
		expect(out.stdout).toBe("");
	});

	it("exits 6 on a bare @ reference, which is not redactable", async () => {
		const out = await run([labelsOk], {_tag: "Text", text: "@notes/weight.md"});
		expect(out.code).toBe(BARE_AT_PATH);
		expect(out.stdout).toBe("");
	});

	it("exits 7 when the wayfinding:map label does not exist", async () => {
		const out = await run([[LABELS, okOut("status:needs-triage")]]);
		expect(out.code).toBe(NO_TARGET);
		expect(out.stderr.join("\n")).toContain("no later run could find");
	});

	it("exits 11 when the map search fails — nothing was written and charting is UNKNOWN", async () => {
		const out = await run([labelsOk, [OPEN_MAPS, errOut("gh: Bad gateway (HTTP 502)")]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
	});

	it("exits 19 when the destination is already recorded out of scope", async () => {
		const out = await run(
			[
				labelsOk,
				[OPEN_MAPS, okOut("9200\twayfinding: something else")],
				[
					EXISTING_MAP,
					okOut(
						issueJson({number: 9200, body: MAP_BODY_WITH_REJECTION, labels: ["wayfinding:map"]}),
					),
				],
			],
			{_tag: "Text", text: QUESTIONS},
			"a per-topic weight multiplier",
		);
		expect(out.code).toBe(ALREADY_DESCOPED);
		expect(out.stderr.join("\n")).toContain("read the recorded reasoning");
	});

	it("exits 16 when two open maps match, refusing to guess which", async () => {
		const body = okOut(issueJson({number: 9200, body: MAP_BODY, labels: ["wayfinding:map"]}));
		const out = await run([
			labelsOk,
			[OPEN_MAPS, okOut("9200\twayfinding: a\n9201\twayfinding: b")],
			[/issues\/9200$/, body],
			[
				/issues\/9201$/,
				okOut(issueJson({number: 9201, body: MAP_BODY, labels: ["wayfinding:map"]})),
			],
		]);
		expect(out.code).toBe(MAP_AMBIGUOUS);
		expect(out.stderr.join("\n")).toContain("close or merge one");
	});
});

describe("runOpen — minting and resuming", () => {
	it("exits 9 when the landed body is not what was composed — the create's echo is not evidence", async () => {
		const out = await run([
			labelsOk,
			noMaps,
			noHits,
			[CREATE, okOut('{"number":9140,"html_url":"https://github.com/o/r/issues/9140"}')],
			[ADD_LABEL, okOut("{}")],
			[NEW_MAP, okOut(minted)],
		]);
		expect(out.code).toBe(READBACK_MISMATCH);
		expect(out.stdout).toBe("");
	});

	it("exits 0 on a mint whose read-back matches, reporting created:true and the digest", async () => {
		const composed = [
			"## Destination",
			"how moderation weight is earned",
			"",
			"## Decisions",
			"",
			"## Frontier",
			"",
			"## Fog",
			"- does a suspended account keep its weight?",
			"- what clock does weight decay on?",
			"",
			"## Out of scope",
			"",
		].join("\n");
		const out = await run([
			labelsOk,
			noMaps,
			noHits,
			[CREATE, okOut('{"number":9140,"html_url":"https://github.com/o/r/issues/9140"}')],
			[ADD_LABEL, okOut("{}")],
			[NEW_MAP, okOut(issueJson({number: 9140, body: composed, labels: ["wayfinding:map"]}))],
		]);
		expect(out.code).toBe(0);
		const answer = JSON.parse(out.stdout);
		expect(answer).toMatchObject({map: 9140, created: true, questions: 2});
		expect(answer.digest).toMatch(/^[0-9a-f]{12}$/);
		expect(answer.scanned).toEqual({maps: 0, candidates: 0});
	});

	it("exits 8 naming the number when the label write does not land — the survivor is inert", async () => {
		const out = await run([
			labelsOk,
			noMaps,
			noHits,
			[CREATE, okOut('{"number":9140,"html_url":"https://github.com/o/r/issues/9140"}')],
			[ADD_LABEL, errOut("gh: Bad gateway (HTTP 502)")],
		]);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("Add wayfinding:map to #9140 by hand");
	});

	it("resumes an already-charted destination without touching its body", async () => {
		const shell = fakeShell([
			labelsOk,
			[OPEN_MAPS, okOut("9200\twayfinding: how moderation weight is earned")],
			[EXISTING_MAP, okOut(issueJson({number: 9200, body: MAP_BODY, labels: ["wayfinding:map"]}))],
			noHits,
		]);
		const out = await Effect.runPromise(
			Effect.provide(
				runOpen({
					destination: "how moderation weight is earned",
					repo: null,
					env: {CLAUDE_PIPELINE_REPO: REPO},
					stdin: Effect.succeed({_tag: "Text", text: QUESTIONS} as StdinRead),
				}),
				shell.layer,
			),
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({map: 9200, created: false, questions: 2});
		expect(shell.calls.some((line) => line.includes("--method PATCH"))).toBe(false);
	});

	it("reports ranked candidates as evidence and charts every question anyway", async () => {
		const composed = [
			"## Destination",
			"how moderation weight is earned",
			"",
			"## Decisions",
			"",
			"## Frontier",
			"",
			"## Fog",
			"- does a suspended account keep its weight?",
			"- what clock does weight decay on?",
			"",
			"## Out of scope",
			"",
		].join("\n");
		const out = await run([
			labelsOk,
			noMaps,
			[once(SEARCH), okOut("9098\tA suspended account keeps its moderation weight")],
			[SEARCH, okOut("")],
			[CREATE, okOut('{"number":9140,"html_url":"https://github.com/o/r/issues/9140"}')],
			[ADD_LABEL, okOut("{}")],
			[NEW_MAP, okOut(issueJson({number: 9140, body: composed, labels: ["wayfinding:map"]}))],
		]);
		expect(out.code).toBe(0);
		const answer = JSON.parse(out.stdout);
		expect(answer.questions).toBe(2);
		expect(answer.answeredCandidates).toHaveLength(1);
		expect(answer.answeredCandidates[0].candidates[0].issue).toBe(9098);
	});
});
