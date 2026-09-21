/**
 * `guard skill-evidence-guard check`'s IO boundary over the scripted seams: the fail-closed seats
 * the verb owns (zero files, an unreadable policy), the CLI-shaped skip, and — through the scripted
 * spawner and HTTP client — the full gather path of one skill: policy from the base commit,
 * `git ls-tree` content probes, word-diff source texts, the committed report, the trusted-run
 * fetch, and the run's published report artifact compared byte-for-byte.
 *
 * The git paths not exercised here (a base tree that resolves, per-file absence at head, a
 * benchmark commit that does not resolve) are the core's `judge` branches over facts, proven by
 * `./skill-evidence.unit.test.ts` — the verb only relays those facts, the judge derives.
 */

import {mkdirSync} from "node:fs";
import {tmpdir} from "node:os";
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs, fakeHttp, fakeShell, type HttpReply, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {PRECONDITION_UNKNOWN, VIOLATION, ZERO_SCOPE} from "./codes.ts";
import {runSkillEvidenceGuard} from "./skill-evidence-verb.ts";

const ROOT = "/repo";
const SKILLS = "claude-plugins/fabrika/skills";
const REPORTS = "benchmarks/skill-evidence/reports";
const PRODUCER = ".github/workflows/skill-benchmark.yml";
const POLICY_PATH = "benchmarks/skill-evidence/policy.json";
const ARTIFACT = "skill-benchmark-report";
// The scratch path must be writable by the REAL `writeFile` the verb uses (the zip is written for
// `unzip -p` to read), so the fake mktemp answers a directory under the platform tmpdir, not a
// POSIX-only /tmp that is `C:\tmp` on Windows.
const SCRATCH = `${tmpdir().replaceAll("\\", "/")}/sb-test`.replace(/\/+$/, "");
const SCRATCH_RE = SCRATCH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
mkdirSync(SCRATCH, {recursive: true});

const TREE_HEAD = `a${"1".repeat(39)}`;
const POLICY_OID = `b${"2".repeat(39)}`;
const ARTIFACT_ID = 77;
const BASE_COMMIT = `f${"6".repeat(39)}`;
const HEAD_COMMIT = `e${"5".repeat(39)}`;
const RUN = 4242;

const POLICY = JSON.stringify({
	producerWorkflow: PRODUCER,
	skillsRoot: SKILLS,
	reportRoot: REPORTS,
	reportArtifact: ARTIFACT,
	thresholds: {
		default: {minRepetitions: 3, successDelta: 0, newCriticalErrors: 0, maxCostRatio: 1.25},
		perSkill: {},
	},
	typoExemption: {mdOnly: true, maxChangedWords: 20, maxWordEditDistance: 2},
});

const reportJson = (): string =>
	JSON.stringify({
		schemaVersion: 1,
		skill: {name: "build", path: `${SKILLS}/build`, treeSha: TREE_HEAD},
		baseline: {kind: "without-skill"},
		model: "test-model",
		tools: "test-tools",
		scenarioSet: "set-a",
		repetitions: 3,
		results: {
			baseline: {scenarios: 10, success: 5, criticalErrors: 0, tokens: 1000, costUsd: 1},
			treatment: {scenarios: 10, success: 7, criticalErrors: 0, tokens: 1200, costUsd: 1.1},
		},
		thresholds: {minRepetitions: 3, successDelta: 0, newCriticalErrors: 0, maxCostRatio: 1.25},
		provenance: {
			workflow: PRODUCER,
			runId: RUN,
			runUrl: `https://github.com/o/r/actions/runs/${RUN}`,
			headSha: HEAD_COMMIT,
		},
	});

const absent = (reason: string): ExecResult => ({ok: false, stdout: "", reason});

const policyBlobAt = (sha: string, text: string): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	[
		new RegExp(`ls-tree ${sha} -- ${POLICY_PATH}$`),
		okOut(`100644 blob ${POLICY_OID}\t${POLICY_PATH}`),
	],
	[new RegExp(`cat-file blob ${POLICY_OID}$`), okOut(text)],
];

/** A blob's `ls-tree` + `cat-file` rows — the two reads `blobAt` makes, as one unit. */
const blobRows = (
	sha: string,
	path: string,
	oid: string,
	text: string | null,
): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	[
		new RegExp(`ls-tree ${sha} -- ${path}$`),
		text === null ? okOut("") : okOut(`100644 blob ${oid}\t${path}`),
	],
	[new RegExp(`cat-file blob ${oid}$`), text === null ? okOut("") : okOut(text)],
];

const SKILL_OID = `c${"3".repeat(39)}`;
const BASE_SKILL_OID = `9${"9".repeat(39)}`;
const REPORT_OID = `d${"4".repeat(39)}`;

/**
 * The git story of a NEW skill changed at head, with the policy read from the BASE commit: the
 * policy blob resolves base-side, the skill's tree resolves at head and is absent at base, the head
 * text adds words over the base text (a behavior change, not the typo lane; the base side of the
 * file is genuinely absent), the benchmark commit resolves, and the committed report reads off the
 * HEAD TREE via its blob — which is what the gate judges rather than any working-tree copy.
 */
const gitScript = (withReport = true): ReadonlyArray<readonly [RegExp, ExecResult]> => {
	const skillArg = `${SKILLS}/build`;
	const rows: Array<readonly [RegExp, ExecResult]> = [
		...policyBlobAt(BASE_COMMIT, POLICY),
		[
			new RegExp(`ls-tree ${HEAD_COMMIT} -- ${skillArg}$`),
			okOut(`040000 tree ${TREE_HEAD}\t${skillArg}`),
		],
		[new RegExp(`ls-tree ${BASE_COMMIT} -- ${skillArg}$`), okOut("")],
		...blobRows(BASE_COMMIT, `${skillArg}/SKILL.md`, BASE_SKILL_OID, null),
		...blobRows(HEAD_COMMIT, `${skillArg}/SKILL.md`, SKILL_OID, "one two three four"),
		[new RegExp(`cat-file -e ${HEAD_COMMIT}\\^\\{commit\\}`), okOut("")],
		...blobRows(
			HEAD_COMMIT,
			`${REPORTS}/build/report\\.json`,
			REPORT_OID,
			withReport ? reportJson() : null,
		),
	];
	return rows;
};

/** The trusted run as a successful, completed run of the producer at the report's head commit. */
const runOk: HttpReply = {
	status: 200,
	body: JSON.stringify({
		path: PRODUCER,
		status: "completed",
		conclusion: "success",
		head_sha: HEAD_COMMIT,
	}),
};

/** The run's published report artifact, listed and downloadable. */
const artifactsOk: HttpReply = {
	status: 200,
	body: JSON.stringify({
		total_count: 1,
		artifacts: [{id: ARTIFACT_ID, name: ARTIFACT, expired: false}],
	}),
};

/** A zip whose first bytes are the magic number and whose `report.json` matches the committed one. */
const zipOk: HttpReply = {status: 200, body: `PK\u0003\u0004${reportJson()}`};

const shellScript = (artifactText: string): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	[/^mktemp -d$/, okOut(SCRATCH)],
	[
		new RegExp(`unzip -p '${SCRATCH_RE}/skill-benchmark-report\\.zip' report\\.json$`),
		okOut(artifactText),
	],
];

const RUN_URL = /GET https:\/\/api\.github\.com\/repos\/o\/r\/actions\/runs\/4242$/;
const ARTIFACTS_URL = /GET https:\/\/api\.github\.com\/repos\/o\/r\/actions\/runs\/4242\/artifacts/;
const ZIP_URL = /GET https:\/\/api\.github\.com\/repos\/o\/r\/actions\/artifacts\/77\/zip$/;

interface RunCase {
	readonly files?: ReadonlyArray<string>;
	readonly env?: Record<string, string | undefined>;
	readonly git?: ReadonlyArray<readonly [RegExp, ExecResult]>;
	readonly http?: ReadonlyArray<readonly [RegExp, HttpReply]>;
	readonly unreachable?: ReadonlyArray<RegExp>;
}

const run = (options: RunCase = {}) => {
	const shell = fakeShell([...(options.git ?? gitScript()), ...shellScript(reportJson())]);
	const http = fakeHttp(
		options.http ?? [
			[RUN_URL, runOk],
			[ARTIFACTS_URL, artifactsOk],
			[ZIP_URL, zipOk],
		],
		undefined,
		options.unreachable ?? [],
	);
	return {
		outcome: Effect.runPromise(
			Effect.provide(
				runSkillEvidenceGuard({
					files: options.files ?? [`${SKILLS}/build/SKILL.md`],
					baseSha: BASE_COMMIT,
					headSha: HEAD_COMMIT,
					repo: "o/r",
					root: ROOT,
					cwd: ROOT,
					env: options.env ?? {GITHUB_TOKEN: "t"},
				}),
				Layer.merge(fakeFs({}).layer, Layer.merge(shell.layer, http.layer)),
			),
		),
		http,
	};
};

describe("runSkillEvidenceGuard", () => {
	it("fails closed on an empty file list, whatever the tree holds", async () => {
		const {outcome} = run({files: []});
		const result = await outcome;
		expect(result.code).toBe(ZERO_SCOPE);
		expect(result.stderr.join("\n")).toContain("handed ZERO files");
	});

	it("answers UNKNOWN when the policy is missing from both base and head", async () => {
		const {outcome} = run({
			git: [
				[new RegExp(`ls-tree ${BASE_COMMIT} -- ${POLICY_PATH}$`), okOut("")],
				[new RegExp(`ls-tree ${HEAD_COMMIT} -- ${POLICY_PATH}$`), okOut("")],
			],
		});
		const result = await outcome;
		expect(result.code).toBe(PRECONDITION_UNKNOWN);
		expect(result.stderr.join("\n")).toContain("missing from both");
	});

	it("answers UNKNOWN when the policy's git read fails — a failed read is never absence", async () => {
		const {outcome} = run({
			git: [
				[
					new RegExp(`ls-tree ${BASE_COMMIT} -- ${POLICY_PATH}$`),
					absent("fatal: not a tree object"),
				],
			],
		});
		const result = await outcome;
		expect(result.code).toBe(PRECONDITION_UNKNOWN);
		expect(result.stderr.join("\n")).toContain("could not be read from");
	});

	it("answers UNKNOWN when the policy exists but is malformed", async () => {
		const {outcome} = run({git: policyBlobAt(BASE_COMMIT, "{nope")});
		const result = await outcome;
		expect(result.code).toBe(PRECONDITION_UNKNOWN);
		expect(result.stderr.join("\n")).toContain("malformed");
	});

	it("bootstraps from the head tree when the policy is absent at base", async () => {
		const {outcome} = run({
			git: [
				[new RegExp(`ls-tree ${BASE_COMMIT} -- ${POLICY_PATH}$`), okOut("")],
				...policyBlobAt(HEAD_COMMIT, POLICY),
				...gitScript().slice(2),
			],
		});
		const result = await outcome;
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("1 skill(s) checked");
	});

	it("skips a diff that touches no skill file, naming the skills root", async () => {
		const {outcome} = run({files: ["README.md", "worker/src/index.ts"]});
		const result = await outcome;
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("0 of 2 changed files under");
	});
});

describe("runSkillEvidenceGuard — one gated skill, end to end over the seams", () => {
	it("passes a fully-evidenced new skill, byte-verified against the run's artifact", async () => {
		const {outcome, http} = run({});
		const result = await outcome;
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("1 skill(s) checked");
		expect(result.stderr).toEqual([]);
		expect(http.calls).toEqual([
			`GET https://api.github.com/repos/o/r/actions/runs/${RUN}`,
			`GET https://api.github.com/repos/o/r/actions/runs/${RUN}/artifacts?per_page=100`,
			`GET https://api.github.com/repos/o/r/actions/artifacts/${ARTIFACT_ID}/zip`,
		]);
	});

	it("reds a report absent from the HEAD tree at the violation seat, naming the expected path", async () => {
		const {outcome} = run({git: gitScript(false)});
		const result = await outcome;
		expect(result.code).toBe(VIOLATION);
		expect(result.stdout).toBe("");
		expect(result.stderr.join("\n")).toContain(`${REPORTS}/build/report.json`);
	});

	it("answers UNKNOWN when the head-side word-diff source read fails — never a zero-word typo", async () => {
		const {outcome} = run({
			// First match wins in the scripted spawner: the head SKILL.md blob read dies before the
			// good row is reached, so the word diff cannot wear "zero changed words".
			git: [
				[new RegExp(`cat-file blob ${SKILL_OID}$`), absent("fatal: object file is corrupt")],
				...gitScript(),
			],
		});
		const result = await outcome;
		expect(result.code).toBe(PRECONDITION_UNKNOWN);
		const err = result.stderr.join("\n");
		expect(err).toContain("a git read failed");
		expect(err).toContain("word-diff source");
	});

	it("answers UNKNOWN when the base-side word-diff source read fails", async () => {
		const {outcome} = run({
			git: [
				[
					new RegExp(`ls-tree ${BASE_COMMIT} -- ${SKILLS}/build/SKILL.md$`),
					okOut(`100644 blob ${BASE_SKILL_OID}\t${SKILLS}/build/SKILL.md`),
				],
				[new RegExp(`cat-file blob ${BASE_SKILL_OID}$`), absent("fatal: object file is corrupt")],
				...gitScript(),
			],
		});
		const result = await outcome;
		expect(result.code).toBe(PRECONDITION_UNKNOWN);
		const err = result.stderr.join("\n");
		expect(err).toContain("a git read failed");
		expect(err).toContain("word-diff source");
	});

	it("answers UNKNOWN when the skill path holds a blob — never read as removed", async () => {
		const {outcome} = run({
			git: [
				[
					new RegExp(`ls-tree ${HEAD_COMMIT} -- ${SKILLS}/build$`),
					okOut(`100644 blob ${SKILL_OID}\t${SKILLS}/build`),
				],
				...gitScript(),
			],
		});
		const result = await outcome;
		expect(result.code).toBe(PRECONDITION_UNKNOWN);
		expect(result.stdout).toBe("");
		const err = result.stderr.join("\n");
		expect(err).toContain("is a blob, not a skill directory");
		expect(err).not.toContain("removed");
	});

	it("answers UNKNOWN when the run id answers 404 — and never reads artifacts", async () => {
		const {outcome, http} = run({http: [[RUN_URL, {status: 404, body: "{}"}]]});
		const result = await outcome;
		expect(result.code).toBe(PRECONDITION_UNKNOWN);
		expect(result.stderr.join("\n")).toContain(
			"was not found among the repository's workflow runs",
		);
		expect(http.calls).toEqual([`GET https://api.github.com/repos/o/r/actions/runs/${RUN}`]);
	});

	it("answers UNKNOWN when the run published no report artifact — the numbers stay unproven", async () => {
		const {outcome} = run({
			http: [
				[RUN_URL, runOk],
				[ARTIFACTS_URL, {status: 200, body: JSON.stringify({total_count: 0, artifacts: []})}],
			],
		});
		const result = await outcome;
		expect(result.code).toBe(PRECONDITION_UNKNOWN);
		expect(result.stderr.join("\n")).toContain(`published no \`${ARTIFACT}\` artifact`);
	});

	it("reds a committed report whose bytes differ from the run's artifact", async () => {
		const forged = `${JSON.stringify(JSON.parse(reportJson()), null, 2)}\n`;
		// The unzip row must answer the FORGED bytes for the mismatch to be exercised; the default
		// run() script answers the committed bytes, so this case wraps its own seams.
		const shell = fakeShell([...gitScript(), ...shellScript(forged)]);
		const http = fakeHttp(
			[
				[RUN_URL, runOk],
				[ARTIFACTS_URL, artifactsOk],
				[ZIP_URL, {status: 200, body: `PK\u0003\u0004${forged}`}],
			],
			undefined,
			[],
		);
		const result = await Effect.runPromise(
			Effect.provide(
				runSkillEvidenceGuard({
					files: [`${SKILLS}/build/SKILL.md`],
					baseSha: BASE_COMMIT,
					headSha: HEAD_COMMIT,
					repo: "o/r",
					root: ROOT,
					cwd: ROOT,
					env: {GITHUB_TOKEN: "t"},
				}),
				Layer.merge(fakeFs({}).layer, Layer.merge(shell.layer, http.layer)),
			),
		);
		expect(result.code).toBe(VIOLATION);
		expect(result.stderr.join("\n")).toContain("bytes differ from the");
	});

	it("answers UNKNOWN when the artifact download answers a non-2xx", async () => {
		const {outcome} = run({
			http: [
				[RUN_URL, runOk],
				[ARTIFACTS_URL, artifactsOk],
				[ZIP_URL, {status: 503, body: "nope"}],
			],
		});
		const result = await outcome;
		expect(result.code).toBe(PRECONDITION_UNKNOWN);
		expect(result.stderr.join("\n")).toContain(
			"could not be read (the artifact download answered HTTP 503)",
		);
	});

	it("answers UNKNOWN when the GitHub API answers a non-2xx the gate cannot read", async () => {
		const {outcome} = run({http: [[RUN_URL, {status: 500, body: '{"message":"nope"}'}]]});
		const result = await outcome;
		expect(result.code).toBe(PRECONDITION_UNKNOWN);
		expect(result.stderr.join("\n")).toContain("the GitHub API could not be read");
	});

	it("reds an in-progress run (conclusion null) as not from the trusted runner, not UNKNOWN", async () => {
		const {outcome} = run({
			http: [
				[
					RUN_URL,
					{
						status: 200,
						body: JSON.stringify({
							path: PRODUCER,
							status: "in_progress",
							conclusion: null,
							head_sha: HEAD_COMMIT,
						}),
					},
				],
			],
		});
		const result = await outcome;
		expect(result.code).toBe(VIOLATION);
		expect(result.stderr.join("\n")).toContain("did not come from the trusted runner");
	});

	it("reads the run and its artifact off a caller-supplied apiBase instead of the public API", async () => {
		const base = "https://gh.example/api/v3/";
		const http = fakeHttp(
			[
				[/GET https:\/\/gh\.example\/api\/v3\/repos\/o\/r\/actions\/runs\/4242$/, runOk],
				[
					/GET https:\/\/gh\.example\/api\/v3\/repos\/o\/r\/actions\/runs\/4242\/artifacts/,
					artifactsOk,
				],
				[/GET https:\/\/gh\.example\/api\/v3\/repos\/o\/r\/actions\/artifacts\/77\/zip$/, zipOk],
			],
			undefined,
			[],
		);
		const shell = fakeShell([...gitScript(), ...shellScript(reportJson())]);
		const result = await Effect.runPromise(
			Effect.provide(
				runSkillEvidenceGuard({
					files: [`${SKILLS}/build/SKILL.md`],
					baseSha: BASE_COMMIT,
					headSha: HEAD_COMMIT,
					repo: "o/r",
					root: ROOT,
					cwd: ROOT,
					env: {GITHUB_TOKEN: "t"},
					apiBase: base,
				}),
				Layer.merge(fakeFs({}).layer, Layer.merge(shell.layer, http.layer)),
			),
		);
		expect(result.code).toBe(0);
		expect(http.calls).toEqual([
			`GET ${base}repos/o/r/actions/runs/${RUN}`,
			`GET ${base}repos/o/r/actions/runs/${RUN}/artifacts?per_page=100`,
			`GET ${base}repos/o/r/actions/artifacts/${ARTIFACT_ID}/zip`,
		]);
	});

	it("answers UNKNOWN when the GitHub API is unreachable", async () => {
		const {outcome} = run({unreachable: [RUN_URL]});
		const result = await outcome;
		expect(result.code).toBe(PRECONDITION_UNKNOWN);
		expect(result.stderr.join("\n")).toContain("the GitHub API could not be read");
	});

	it("answers UNKNOWN without a token, and never reaches for the API", async () => {
		const {outcome, http} = run({env: {}});
		const result = await outcome;
		expect(result.code).toBe(PRECONDITION_UNKNOWN);
		expect(result.stderr.join("\n")).toContain("cannot verify provenance without GITHUB_TOKEN");
		expect(http.calls).toEqual([]);
	});
});
