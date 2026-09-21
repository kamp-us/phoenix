/**
 * `guard skill-evidence-guard check` — a change to a skill under the skills root carries committed
 * benchmark evidence from the trusted in-repo runner, bound to the exact skill content the PR ships
 * (ADR 0403).
 *
 * The verb is the IO boundary and nothing else: it resolves the repo root, reads the policy, gathers
 * the git facts (skill trees at base/head, per-file contents for the word diff, benchmark-commit
 * reachability), reads each skill's committed report, fetches the trusted run off the GitHub API,
 * hands all of it to the rule in `./skill-evidence.ts`, and seats the answer on the group's exit
 * taxonomy.
 *
 * Two reads have no violation seat, deliberately: a policy the gate cannot read proves nothing
 * (UNKNOWN), and a GitHub read that could not be made proves nothing either (UNKNOWN) — never clean.
 *
 * See `guard skill-evidence-guard check --help` for results and exit codes.
 */

import {Effect, type FileSystem, Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {discoverRepoRoot} from "../delegate/root.ts";
import {execCapture} from "../io/exec.ts";
import {exists, type ReadFailed, readFile} from "../io/fs.ts";
import {onTransport, restRead} from "../io/gh-api.ts";
import {isRecord} from "../io/json.ts";
import type {VerbOutcome} from "../verb.ts";
import {
	diffWords,
	groupSkillFiles,
	judge,
	type ProvenanceFacts,
	parsePolicy,
	parseReport,
	type ReportOutcome,
	type SkillEvidencePolicy,
	type SkillFacts,
	type TypoFacts,
	validateReport,
	type WordPair,
	ZERO_FILES_REPORT,
} from "./skill-evidence.ts";
import {emitVerdict, unknown, zeroScope} from "./verdict.ts";

const VERB = "guard skill-evidence-guard check";

/** The gate's own config — the one path the policy does not get to move. */
const POLICY_PATH = "benchmarks/skill-evidence/policy.json";

/** Where the trusted run is read from, unless the caller says otherwise. */
export const DEFAULT_API_BASE = "https://api.github.com";

export interface SkillEvidenceGuardOptions {
	/** The changed files to judge, as the workflow resolved them — repo-relative or absolute. */
	readonly files: ReadonlyArray<string>;
	/** The base commit SHA (the PR's merge-base side); the previous-version baseline binds here. */
	readonly baseSha: string;
	/** The head commit SHA; the report's `skill.treeSha` must match the skill's tree here. */
	readonly headSha: string;
	/** The `owner/name` whose actions the trusted run is read from. */
	readonly repo: string;
	/** An explicit repo root, or `null` to walk up from `cwd` for one. */
	readonly root: string | null;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** Overrides the GitHub REST root the run is read from; the default is the public API. */
	readonly apiBase?: string | undefined;
}

/** This verb's one requirement beyond the filesystem: git, through the platform spawner. */
type Gather<A, E = ReadFailed> = Effect.Effect<
	A,
	E,
	FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
>;

/**
 * The SHA of the tree at `path` under `sha`, or `null` when the path is absent there — or holds
 * something that is not a tree: `<rev>:<path>` names ANY object at that path (a stray blob at the
 * skills-root path must not pose as a skill), and gitrevisions peel suffixes like `^{tree}` attach
 * to revs, never after the `<rev>:<path>` colon form — appending one there makes it part of the
 * PATH — so the type is proven by a second read, `cat-file -t`.
 */
const treeShaAt = (root: string, sha: string, path: string): Gather<string | null, never> =>
	Effect.gen(function* () {
		const read = yield* execCapture("git", [
			"-C",
			root,
			"rev-parse",
			"--verify",
			"--quiet",
			`${sha}:${path}`,
		]);
		const oid = read.ok ? read.stdout.trim() : "";
		if (!/^[0-9a-f]{40}$/.test(oid)) return null;
		const type = yield* execCapture("git", ["-C", root, "cat-file", "-t", oid]);
		return type.ok && type.stdout.trim() === "tree" ? oid : null;
	});

/** One file's contents at `sha`, or `null` when the file is absent — a new file has no base text. */
const fileAt = (root: string, sha: string, file: string): Gather<string | null, never> =>
	Effect.map(execCapture("git", ["-C", root, "show", `${sha}:${file}`]), (read) =>
		read.ok ? read.stdout : null,
	);

/** Whether `sha` resolves to a commit in this clone's object database. */
const commitPresent = (root: string, sha: string): Gather<boolean, never> =>
	Effect.map(
		execCapture("git", ["-C", root, "cat-file", "-e", `${sha}^{commit}`]),
		(read) => read.ok,
	);

/** The credential this gate reads: `GITHUB_TOKEN`, then `GH_TOKEN`. No `gh` leg — CI has neither ambiguity nor the binary. */
const tokenOf = (env: Readonly<Record<string, string | undefined>>): string => {
	for (const named of [env.GITHUB_TOKEN, env.GH_TOKEN]) {
		const token = (named ?? "").trim();
		if (token !== "") return token;
	}
	return "";
};

/**
 * The trusted run as the GitHub API answered it.
 *
 * A served 404 is a fact (`exists: false` — the judge seats it on UNKNOWN, because a permission
 * loss and a deleted run answer the same here). An unreachable API, any other non-2xx, or a 200
 * whose body is not the run shape is `null`: the read could not be made, so nothing is proven.
 */
const fetchRun = (
	repo: string,
	runId: number,
	token: string,
	apiBase: string,
): Effect.Effect<ProvenanceFacts["run"]> =>
	onTransport(
		Effect.map(
			restRead(
				token,
				"GET",
				apiBase === DEFAULT_API_BASE
					? `repos/${repo}/actions/runs/${runId}`
					: `${apiBase.replace(/\/+$/, "")}/repos/${repo}/actions/runs/${runId}`,
			),
			(outcome) => {
				if (outcome._tag === "Unreachable") return null;
				if (outcome.status === 404) return {exists: false};
				if (outcome.status < 200 || outcome.status >= 300) return null;
				const body = outcome.body;
				if (!isRecord(body)) return null;
				// `conclusion` is the platform's nullable: `null` while the run has not finished. Keeping
				// it (rather than refusing the shape) is what lets the judge seat an unfinished run as a
				// red "not completed" instead of folding it into an unreadable-API UNKNOWN.
				if (
					typeof body.path !== "string" ||
					typeof body.status !== "string" ||
					!(body.conclusion === null || typeof body.conclusion === "string") ||
					typeof body.head_sha !== "string"
				) {
					return null;
				}
				return {
					exists: true,
					path: body.path,
					status: body.status,
					conclusion: body.conclusion,
					headSha: body.head_sha,
				};
			},
		),
	);

type PolicyLoad =
	| {readonly _tag: "Loaded"; readonly policy: SkillEvidencePolicy}
	| {readonly _tag: "Unusable"; readonly reason: string};

const loadPolicy = (root: string): Gather<PolicyLoad> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const policyPath = path.join(root, ...POLICY_PATH.split("/"));
		if (!(yield* exists(policyPath))) {
			return {_tag: "Unusable", reason: `missing at ${POLICY_PATH}`} as const;
		}
		const parsed = parsePolicy(yield* readFile(policyPath));
		return parsed._tag === "Ok"
			? ({_tag: "Loaded", policy: parsed.policy} as const)
			: ({
					_tag: "Unusable",
					reason: `malformed at ${POLICY_PATH}: ${parsed.errors.join("; ")}`,
				} as const);
	});

/**
 * One skill's whole fact set: trees at base and head, the word-diff facts of its changed files, its
 * committed report, and — only when the report validated, because provenance keys off its runId —
 * the trusted run and the content binding at the benchmark commit.
 */
const gatherSkill = (
	root: string,
	options: SkillEvidenceGuardOptions,
	policy: SkillEvidencePolicy,
	name: string,
	files: ReadonlyArray<string>,
): Gather<SkillFacts> =>
	Effect.gen(function* () {
		const skillPath = `${policy.skillsRoot}/${name}`;
		const headTreeSha = yield* treeShaAt(root, options.headSha, skillPath);
		const baseTreeSha = yield* treeShaAt(root, options.baseSha, skillPath);

		const nonMdFiles: Array<string> = [];
		let mdFiles = 0;
		let changedWords = 0;
		const pairs: Array<WordPair> = [];
		for (const file of files) {
			if (!file.endsWith(".md")) {
				nonMdFiles.push(file);
				continue;
			}
			mdFiles++;
			// A file absent at one end is the whole-file diff against "" — a new file's every word
			// counts, which is what keeps "whole file added" out of the typo lane unless it is tiny.
			const before = (yield* fileAt(root, options.baseSha, file)) ?? "";
			const after = (yield* fileAt(root, options.headSha, file)) ?? "";
			const diff = diffWords(before, after);
			changedWords += diff.changedWords;
			pairs.push(...diff.pairs);
		}
		const typo: TypoFacts = {nonMdFiles, mdFiles, changedWords, pairs};

		// The report is read from the HEAD TREE, not the working tree: what merges is the commit, and
		// a locally-modified-but-uncommitted report must never gate what the commit actually ships.
		const reportRel = `${policy.reportRoot}/${name}/report.json`;
		const committed = yield* fileAt(root, options.headSha, reportRel);
		const report: ReportOutcome =
			committed === null
				? {
						_tag: "ReadError",
						reason: `not committed at the head tree (${reportRel} absent at ${options.headSha})`,
					}
				: parseReport(committed);

		const token = tokenOf(options.env);
		let provenance: ProvenanceFacts = {
			reachable: true,
			run: null,
			tokenPresent: token !== "",
			benchmarkTreeAtHeadSha: null,
		};
		if (report._tag === "Json") {
			const validated = validateReport(report.value);
			if (validated._tag === "Ok") {
				const run =
					token !== ""
						? yield* fetchRun(
								options.repo,
								validated.report.provenance.runId,
								token,
								options.apiBase ?? DEFAULT_API_BASE,
							)
						: null;
				const reachable = yield* commitPresent(root, validated.report.provenance.headSha);
				const benchmarkTreeAtHeadSha = reachable
					? yield* treeShaAt(root, validated.report.provenance.headSha, skillPath)
					: null;
				provenance = {reachable, run, tokenPresent: token !== "", benchmarkTreeAtHeadSha};
			}
		}

		return {
			name,
			existsAtHead: headTreeSha !== null,
			existsAtBase: baseTreeSha !== null,
			headTreeSha,
			baseTreeSha,
			changedFiles: files,
			typo,
			report,
			provenance,
		};
	});

export const runSkillEvidenceGuard = (
	options: SkillEvidenceGuardOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const root =
			options.root ??
			(yield* discoverRepoRoot(options.cwd).pipe(Effect.map((found) => found ?? null)));
		if (root === null) {
			return emitVerdict(
				unknown(
					`${VERB}: no repo root at or above ${options.cwd} — nothing to scope the scan to, so the verdict is UNKNOWN.`,
				),
				options.env,
			);
		}
		// Before the policy read, mirroring leak's ordering: a broken caller's zero-file invocation
		// reds on zero scope whatever the policy's state — the gate never needs config to refuse.
		if (options.files.length === 0) {
			return emitVerdict(zeroScope(ZERO_FILES_REPORT), options.env);
		}
		const loaded = yield* loadPolicy(root);
		if (loaded._tag === "Unusable") {
			return emitVerdict(
				unknown(
					`${VERB}: the gate's own policy is ${loaded.reason} — the gate's config is unreadable, so nothing is proven and the verdict is UNKNOWN, never clean.`,
				),
				options.env,
			);
		}
		const {policy} = loaded;
		const skills: Array<SkillFacts> = [];
		for (const [name, files] of groupSkillFiles(options.files, policy.skillsRoot)) {
			skills.push(yield* gatherSkill(root, options, policy, name, files));
		}
		return emitVerdict(judge({files: options.files, skills, policy}), options.env);
	}).pipe(
		Effect.catchTag("fabrika-cli/ReadFailed", (failure) =>
			Effect.succeed(
				emitVerdict(
					unknown(
						`${VERB}: cannot read ${failure.path}: ${failure.reason} — the scan could not be completed, so the verdict is UNKNOWN, never clean.`,
					),
					options.env,
				),
			),
		),
	);
