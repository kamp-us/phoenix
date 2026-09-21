/**
 * `guard skill-evidence-guard check`'s IO boundary over the scripted seams: the fail-closed seats
 * the verb owns (zero files, an unreadable policy), the CLI-shaped skip, and — through the scripted
 * spawner and HTTP client — the full gather path of one skill: git trees, word-diff source texts,
 * the committed report, and the trusted-run fetch with its three API answers.
 *
 * The git paths not exercised here (a base tree that resolves, per-file absence at head, a
 * benchmark commit that does not resolve) are the core's `judge` branches over facts, proven by
 * `./skill-evidence.unit.test.ts` — the verb only relays those facts (ADR 0228).
 */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {
	type FakeFsOptions,
	fakeFs,
	fakeHttp,
	fakeShell,
	type HttpReply,
	okOut,
} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {PRECONDITION_UNKNOWN, VIOLATION, ZERO_SCOPE} from "./codes.ts";
import {runSkillEvidenceGuard} from "./skill-evidence-verb.ts";

const ROOT = "/repo";
const SKILLS = "claude-plugins/fabrika/skills";
const REPORTS = "benchmarks/skill-evidence/reports";
const PRODUCER = ".github/workflows/skill-benchmark.yml";

const TREE_HEAD = `a${"1".repeat(39)}`;
const BASE_COMMIT = `f${"6".repeat(39)}`;
const HEAD_COMMIT = `e${"5".repeat(39)}`;
const RUN = 4242;

const POLICY = JSON.stringify({
	producerWorkflow: PRODUCER,
	skillsRoot: SKILLS,
	reportRoot: REPORTS,
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
			runUrl: `https://github.com/kamp-us/phoenix/actions/runs/${RUN}`,
			headSha: HEAD_COMMIT,
		},
	});

const absent = (reason: string): ExecResult => ({ok: false, stdout: "", reason});

/**
 * The git story of a NEW skill changed at head: the head tree and the benchmark commit resolve, the
 * base side of everything fails (the skill is absent there), the head text adds words over the base
 * text — a behavior change, not the typo lane — and the committed report reads off the HEAD TREE
 * (`git show <head>:<report path>`), which is what the gate judges rather than any working-tree copy.
 */
const gitScript = (withReport = true): ReadonlyArray<readonly [RegExp, ExecResult]> => {
	const skillArg = `${SKILLS}/build`;
	const rows: Array<readonly [RegExp, ExecResult]> = [
		[new RegExp(`rev-parse --verify --quiet ${HEAD_COMMIT}:${skillArg}$`), okOut(TREE_HEAD)],
		// `<rev>:<path>` names any object there; the verb proves the answer is a TREE with a second
		// read (`cat-file -t`) — a blob at the skills-root path must not pose as a skill.
		[new RegExp(`cat-file -t ${TREE_HEAD}$`), okOut("tree")],
		[new RegExp(`rev-parse --verify --quiet ${BASE_COMMIT}:`), absent("absent at base")],
		[new RegExp(`show ${BASE_COMMIT}:`), absent("absent at base")],
		[new RegExp(`show ${HEAD_COMMIT}:${skillArg}/SKILL.md`), okOut("one two three four")],
		[new RegExp(`cat-file -e ${HEAD_COMMIT}\\^\\{commit\\}`), okOut("")],
	];
	if (withReport) {
		rows.push([
			new RegExp(`show ${HEAD_COMMIT}:${REPORTS}/build/report\\.json`),
			okOut(reportJson()),
		]);
	}
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

const RUN_URL = /GET https:\/\/api\.github\.com\/repos\/kamp-us\/phoenix\/actions\/runs\/4242/;

interface RunCase {
	readonly files?: ReadonlyArray<string>;
	readonly env?: Record<string, string | undefined>;
	readonly git?: ReadonlyArray<readonly [RegExp, ExecResult]>;
	readonly http?: ReadonlyArray<readonly [RegExp, HttpReply]>;
	readonly unreachable?: ReadonlyArray<RegExp>;
}

const run = (fsOptions: FakeFsOptions, options: RunCase = {}) => {
	const shell = fakeShell(options.git ?? gitScript());
	const http = fakeHttp(options.http ?? [[RUN_URL, runOk]], undefined, options.unreachable ?? []);
	return {
		outcome: Effect.runPromise(
			Effect.provide(
				runSkillEvidenceGuard({
					files: options.files ?? [`${SKILLS}/build/SKILL.md`],
					baseSha: BASE_COMMIT,
					headSha: HEAD_COMMIT,
					repo: "kamp-us/phoenix",
					root: ROOT,
					cwd: ROOT,
					env: options.env ?? {GITHUB_TOKEN: "t"},
				}),
				Layer.merge(fakeFs(fsOptions).layer, Layer.merge(shell.layer, http.layer)),
			),
		),
		http,
	};
};

const repoTree = (files: Readonly<Record<string, string>>): FakeFsOptions => ({
	files: Object.fromEntries(Object.entries(files).map(([name, text]) => [`${ROOT}/${name}`, text])),
});

/** The fs side of a runnable gate: the policy on disk. The report rides the git seam, not this one. */
const fullTree = (): FakeFsOptions => repoTree({"benchmarks/skill-evidence/policy.json": POLICY});

describe("runSkillEvidenceGuard", () => {
	it("fails closed on an empty file list, whatever the tree holds", async () => {
		const {outcome} = run(repoTree({"benchmarks/skill-evidence/policy.json": POLICY}), {files: []});
		const result = await outcome;
		expect(result.code).toBe(ZERO_SCOPE);
		expect(result.stderr.join("\n")).toContain("handed ZERO files");
	});

	it("answers UNKNOWN when the gate's own policy file is missing", async () => {
		const {outcome} = run(repoTree({}));
		const result = await outcome;
		expect(result.code).toBe(PRECONDITION_UNKNOWN);
		expect(result.stderr.join("\n")).toContain("the gate's own policy is missing");
	});

	it("answers UNKNOWN when the policy exists but is malformed", async () => {
		const {outcome} = run(repoTree({"benchmarks/skill-evidence/policy.json": "{nope"}));
		const result = await outcome;
		expect(result.code).toBe(PRECONDITION_UNKNOWN);
		expect(result.stderr.join("\n")).toContain("malformed");
	});

	it("answers UNKNOWN when the policy exists but cannot be read", async () => {
		const {outcome} = run(
			{
				...repoTree({"benchmarks/skill-evidence/policy.json": POLICY}),
				unreadable: [`${ROOT}/benchmarks/skill-evidence/policy.json`],
			},
			{},
		);
		const result = await outcome;
		expect(result.code).toBe(PRECONDITION_UNKNOWN);
		expect(result.stderr.join("\n")).toContain("UNKNOWN");
	});

	it("skips a diff that touches no skill file, naming the skills root", async () => {
		const {outcome} = run(repoTree({"benchmarks/skill-evidence/policy.json": POLICY}), {
			files: ["README.md", "apps/web/worker/index.ts"],
		});
		const result = await outcome;
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("0 of 2 changed files under");
	});
});

describe("runSkillEvidenceGuard — one gated skill, end to end over the seams", () => {
	it("passes a fully-evidenced new skill, having read the trusted run once", async () => {
		const {outcome, http} = run(fullTree());
		const result = await outcome;
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("1 skill(s) checked");
		expect(result.stderr).toEqual([]);
		expect(http.calls).toEqual([
			`GET https://api.github.com/repos/kamp-us/phoenix/actions/runs/${RUN}`,
		]);
	});

	it("reds a report absent from the HEAD tree at the violation seat, naming the expected path", async () => {
		const {outcome} = run(fullTree(), {git: gitScript(false)});
		const result = await outcome;
		expect(result.code).toBe(VIOLATION);
		expect(result.stdout).toBe("");
		expect(result.stderr.join("\n")).toContain(`${REPORTS}/build/report.json`);
	});

	it("answers UNKNOWN when the run id answers 404", async () => {
		const {outcome} = run(fullTree(), {http: [[RUN_URL, {status: 404, body: "{}"}]]});
		const result = await outcome;
		expect(result.code).toBe(PRECONDITION_UNKNOWN);
		expect(result.stderr.join("\n")).toContain(
			"was not found among the repository's workflow runs",
		);
	});

	it("answers UNKNOWN when the GitHub API answers a non-2xx the gate cannot read", async () => {
		const {outcome} = run(fullTree(), {
			http: [[RUN_URL, {status: 500, body: '{"message":"nope"}'}]],
		});
		const result = await outcome;
		expect(result.code).toBe(PRECONDITION_UNKNOWN);
		expect(result.stderr.join("\n")).toContain("the GitHub API could not be read");
	});

	it("reds an in-progress run (conclusion null) as not from the trusted runner, not UNKNOWN", async () => {
		const {outcome} = run(fullTree(), {
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

	it("reads the run off a caller-supplied apiBase instead of the public API", async () => {
		const base = "https://gh.example/api/v3/";
		const http = fakeHttp(
			[[/GET https:\/\/gh\.example\/api\/v3\/repos\/kamp-us\/phoenix\/actions\/runs\/4242/, runOk]],
			undefined,
			[],
		);
		const shell = fakeShell(gitScript());
		const result = await Effect.runPromise(
			Effect.provide(
				runSkillEvidenceGuard({
					files: [`${SKILLS}/build/SKILL.md`],
					baseSha: BASE_COMMIT,
					headSha: HEAD_COMMIT,
					repo: "kamp-us/phoenix",
					root: ROOT,
					cwd: ROOT,
					env: {GITHUB_TOKEN: "t"},
					apiBase: base,
				}),
				Layer.merge(fakeFs(fullTree()).layer, Layer.merge(shell.layer, http.layer)),
			),
		);
		expect(result.code).toBe(0);
		expect(http.calls).toEqual([`GET ${base}repos/kamp-us/phoenix/actions/runs/${RUN}`]);
	});

	it("answers UNKNOWN when the GitHub API is unreachable", async () => {
		const {outcome} = run(fullTree(), {unreachable: [RUN_URL]});
		const result = await outcome;
		expect(result.code).toBe(PRECONDITION_UNKNOWN);
		expect(result.stderr.join("\n")).toContain("the GitHub API could not be read");
	});

	it("answers UNKNOWN without a token, and never reaches for the API", async () => {
		const {outcome, http} = run(fullTree(), {env: {}});
		const result = await outcome;
		expect(result.code).toBe(PRECONDITION_UNKNOWN);
		expect(result.stderr.join("\n")).toContain("cannot verify provenance without GITHUB_TOKEN");
		expect(http.calls).toEqual([]);
	});
});
