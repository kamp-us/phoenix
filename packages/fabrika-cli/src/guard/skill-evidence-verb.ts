/**
 * `guard skill-evidence-guard check` — a change to a skill under the skills root carries committed
 * benchmark evidence from the trusted in-repo runner, bound to the exact skill content the PR ships
 * (the founder ruling of 2026-09-21).
 *
 * The verb is the IO boundary and nothing else: it resolves the repo root, reads the policy, gathers
 * the git facts (skill trees at base/head, per-file contents for the word diff, benchmark-commit
 * reachability), reads each skill's committed report, fetches the trusted run off the GitHub API
 * plus the report artifact that run published, hands all of it to the rule in `./skill-evidence.ts`,
 * and seats the answer on the group's exit taxonomy.
 *
 * Three reads have no violation seat, deliberately — they seat UNKNOWN instead, because a gate that
 * cannot make a read proves nothing by guessing: the policy (read from the BASE commit, so a PR
 * cannot relax its own thresholds), a git read that fails while establishing a skill's content
 * (carried as `gitError`, never as "skill absent"), and any GitHub read on the provenance path.
 *
 * See `guard skill-evidence-guard check --help` for results and exit codes.
 */

import {writeFile} from "node:fs/promises";
import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {discoverRepoRoot} from "../delegate/root.ts";
import {execCapture} from "../io/exec.ts";
import type {ReadFailed} from "../io/fs.ts";
import {onTransport, restBytes, restRead} from "../io/gh-api.ts";
import {isRecord} from "../io/json.ts";
import type {VerbOutcome} from "../verb.ts";
import {
	type ArtifactBinding,
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

/** The one file the policy's `reportArtifact` zip must carry: the report, byte-identical. */
const ARTIFACT_REPORT_ENTRY = "report.json";

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
 * What sits at `path` under `sha`, as `git ls-tree` answers it — the one primitive that separates
 * the three states a content probe must never collapse: a git/infrastructure read that FAILED
 * (nonzero exit — the verb carries this as `gitError`, never as absence), the path being genuinely
 * ABSENT (empty output, exit 0), and an object being present with its type (`tree` for a skill
 * directory, so a stray blob at the path cannot pose as a skill).
 */
export type ObjectProbe =
	| {readonly _tag: "Object"; readonly type: string; readonly oid: string}
	| {readonly _tag: "Absent"}
	| {readonly _tag: "GitError"; readonly reason: string};

const objectAt = (root: string, sha: string, path: string): Gather<ObjectProbe, never> =>
	Effect.map(execCapture("git", ["-C", root, "ls-tree", sha, "--", path]), (read) => {
		if (!read.ok) return {_tag: "GitError", reason: read.reason} as const;
		const line = read.stdout.trim();
		if (line === "") return {_tag: "Absent"} as const;
		const match = /^[0-6]{6} ([a-z]+) ([0-9a-f]{40})\t/.exec(line);
		return match === null
			? ({_tag: "GitError", reason: "unparseable `git ls-tree` output"} as const)
			: ({_tag: "Object", type: match[1] ?? "", oid: match[2] ?? ""} as const);
	});

/** The tree SHA at `path`, or `null` when nothing tree-shaped sits there. */
const treeShaAt = (root: string, sha: string, path: string): Gather<string | null, never> =>
	Effect.map(objectAt(root, sha, path), (probe) =>
		probe._tag === "Object" && probe.type === "tree" ? probe.oid : null,
	);

/**
 * One BLOB's contents at `sha` — the policy and the committed report are files, so a directory (or
 * any non-blob) at their exact path is a broken tree, not "absent".
 */
type BlobRead =
	| {readonly _tag: "Ok"; readonly text: string}
	| {readonly _tag: "Absent"}
	| {readonly _tag: "GitError"; readonly reason: string};

const blobAt = (root: string, sha: string, path: string): Gather<BlobRead, never> =>
	Effect.gen(function* () {
		const probe = yield* objectAt(root, sha, path);
		if (probe._tag === "GitError") return probe;
		if (probe._tag === "Absent") return {_tag: "Absent"} as const;
		if (probe.type !== "blob")
			return {
				_tag: "GitError",
				reason: `${path} under ${sha} is a ${probe.type}, not a file`,
			} as const;
		const read = yield* execCapture("git", ["-C", root, "cat-file", "blob", probe.oid]);
		return read.ok
			? ({_tag: "Ok", text: read.stdout} as const)
			: ({_tag: "GitError", reason: read.reason} as const);
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

/** The GitHub path for `restRead`, honoring a caller-supplied REST root. */
const apiPath = (apiBase: string, path: string): string =>
	apiBase === DEFAULT_API_BASE ? path : `${apiBase.replace(/\/+$/, "")}/${path}`;

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
			restRead(token, "GET", apiPath(apiBase, `repos/${repo}/actions/runs/${runId}`)),
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

/**
 * The report artifact the trusted run published, compared byte-for-byte against the committed
 * report — the binding that keeps the committed numbers from being self-attested (the same
 * fetch-the-artifact posture `ship evidence` takes toward its bundle).
 *
 * A listing that lags or cannot be read, a zip that is not a zip, and an unzip that cannot run are
 * `Unreadable` — UNKNOWN seats, never clean. An expired or absent artifact is `Missing`, same seat.
 * Only a byte-identical `report.json` inside the zip answers `Match`.
 */
const fetchReportArtifact = (
	repo: string,
	runId: number,
	token: string,
	apiBase: string,
	artifactName: string,
	committedReport: string,
): Effect.Effect<ArtifactBinding, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const listed = yield* onTransport(
			Effect.map(
				restRead(
					token,
					"GET",
					apiPath(apiBase, `repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`),
				),
				(outcome): ArtifactBinding | {readonly _tag: "Found"; readonly id: number} => {
					if (outcome._tag === "Unreachable")
						return {_tag: "Unreadable", reason: "the artifact list could not be read"};
					if (outcome.status === 404) return {_tag: "Missing"};
					if (outcome.status < 200 || outcome.status >= 300)
						return {
							_tag: "Unreadable",
							reason: `the artifact list answered HTTP ${outcome.status}`,
						};
					const body = outcome.body;
					if (
						!isRecord(body) ||
						typeof body.total_count !== "number" ||
						!Array.isArray(body.artifacts)
					)
						return {_tag: "Unreadable", reason: "the artifact list is not the platform's shape"};
					if (body.artifacts.length < body.total_count)
						return {
							_tag: "Unreadable",
							reason: `a partial artifact listing (${body.artifacts.length} of ${body.total_count})`,
						};
					for (const value of body.artifacts) {
						if (!isRecord(value) || typeof value.id !== "number" || typeof value.name !== "string")
							return {_tag: "Unreadable", reason: "one artifact entry is not the platform's shape"};
						if (value.name === artifactName)
							return value.expired === true ? {_tag: "Missing"} : {_tag: "Found", id: value.id};
					}
					return {_tag: "Missing"};
				},
			),
		);
		if (listed._tag !== "Found") return listed;

		const zip = yield* onTransport(
			Effect.map(
				restBytes(token, apiPath(apiBase, `repos/${repo}/actions/artifacts/${listed.id}/zip`)),
				(outcome): ArtifactBinding | {readonly _tag: "Bytes"; readonly bytes: Uint8Array} => {
					if (outcome._tag === "Unreachable")
						return {_tag: "Unreadable", reason: "the artifact could not be downloaded"};
					if (outcome.status < 200 || outcome.status >= 300)
						return {
							_tag: "Unreadable",
							reason: `the artifact download answered HTTP ${outcome.status}`,
						};
					// A 503 body saved with a `.zip` name is not a bundle — the magic bytes decide.
					return outcome.value[0] === 0x50 && outcome.value[1] === 0x4b
						? ({_tag: "Bytes", bytes: outcome.value} as const)
						: ({_tag: "Unreadable", reason: "the downloaded artifact is not a zip"} as const);
				},
			),
		);
		if (zip._tag !== "Bytes") return zip;

		const scratch = yield* Effect.map(execCapture("mktemp", ["-d"]), (read) =>
			read.ok && read.stdout.trim() !== ""
				? ({_tag: "Dir", dir: read.stdout.trim()} as const)
				: ({_tag: "Unreadable", reason: "a scratch directory could not be created"} as const),
		);
		if (scratch._tag === "Unreadable") return scratch;
		const zipPath = `${scratch.dir}/skill-benchmark-report.zip`;
		const written = yield* Effect.tryPromise({
			try: () => writeFile(zipPath, zip.bytes),
			catch: (cause) => `the artifact could not be written: ${String(cause)}`,
		}).pipe(
			Effect.match({
				onFailure: (reason): ArtifactBinding => ({_tag: "Unreadable", reason}),
				onSuccess: (): {_tag: "Written"} => ({_tag: "Written"}),
			}),
		);
		if (written._tag === "Unreadable") return written;

		return yield* Effect.map(
			execCapture("sh", ["-c", `unzip -p '${zipPath}' ${ARTIFACT_REPORT_ENTRY}`]),
			(read): ArtifactBinding =>
				read.ok
					? read.stdout === committedReport
						? {_tag: "Match"}
						: {_tag: "Mismatch"}
					: {_tag: "Unreadable", reason: read.reason},
		);
	});

type PolicyLoad =
	| {readonly _tag: "Loaded"; readonly policy: SkillEvidencePolicy}
	| {readonly _tag: "Unusable"; readonly reason: string};

/**
 * The gate's policy, read from the BASE commit — the trust anchor.
 *
 * A policy read from the PR head lets one commit relax its own thresholds, widen its typo
 * exemption, or move the report root it is judged under. Reading base-side makes every policy
 * change its own reviewable diff that takes effect only AFTER it merges: the PR that relaxes the
 * policy is still judged by the policy it is relaxing. The head-side read exists only to bootstrap
 * (the PR that first lands the policy has no base copy yet) and can never serve as a relaxation
 * vector once the policy exists at base — which, after the bootstrap merge, is always.
 */
const loadPolicy = (root: string, baseSha: string, headSha: string): Gather<PolicyLoad> =>
	Effect.gen(function* () {
		const atBase = yield* blobAt(root, baseSha, POLICY_PATH);
		let text: string;
		if (atBase._tag === "GitError") {
			return {
				_tag: "Unusable",
				reason: `could not be read from ${baseSha} (${atBase.reason})`,
			} as const;
		}
		if (atBase._tag === "Ok") {
			text = atBase.text;
		} else {
			const atHead = yield* blobAt(root, headSha, POLICY_PATH);
			if (atHead._tag === "GitError")
				return {
					_tag: "Unusable",
					reason: `could not be read from ${headSha} (${atHead.reason})`,
				} as const;
			if (atHead._tag !== "Ok")
				return {
					_tag: "Unusable",
					reason: `missing from both ${baseSha} and ${headSha} — the policy must exist before a skill change can be judged`,
				} as const;
			text = atHead.text;
		}
		const parsed = parsePolicy(text);
		return parsed._tag === "Ok"
			? ({_tag: "Loaded", policy: parsed.policy} as const)
			: ({
					_tag: "Unusable",
					reason: `malformed at ${POLICY_PATH}: ${parsed.errors.join("; ")}`,
				} as const);
	});

/**
 * One skill's whole fact set: trees at base and head (through `objectAt`, so a failed git read
 * arrives as `gitError` and never as absence), the word-diff facts of its changed files, its
 * committed report, and — only when the report validated, because provenance keys off its runId —
 * the trusted run, the artifact that run published, and the content binding at the benchmark
 * commit.
 */
const gatherSkill = (
	root: string,
	options: SkillEvidenceGuardOptions,
	policy: SkillEvidencePolicy,
	name: string,
	files: ReadonlyArray<string>,
): Gather<SkillFacts> =>
	Effect.gen(function* () {
		const token = tokenOf(options.env);
		const provenanceDefaults: ProvenanceFacts = {
			reachable: false,
			run: null,
			tokenPresent: token !== "",
			benchmarkTreeAtHeadSha: null,
			artifact: {_tag: "NotChecked"},
		};
		const skillPath = `${policy.skillsRoot}/${name}`;
		const headProbe = yield* objectAt(root, options.headSha, skillPath);
		const baseProbe = yield* objectAt(root, options.baseSha, skillPath);
		if (headProbe._tag === "GitError" || baseProbe._tag === "GitError") {
			const reason =
				headProbe._tag === "GitError"
					? headProbe.reason
					: (baseProbe as {readonly reason: string}).reason;
			return {
				name,
				existsAtHead: false,
				existsAtBase: false,
				headTreeSha: null,
				baseTreeSha: null,
				changedFiles: files,
				typo: {nonMdFiles: [], mdFiles: 0, changedWords: 0, pairs: []},
				report: {_tag: "ReadError", reason: "not read — the content probe failed"},
				provenance: provenanceDefaults,
				gitError: reason,
			};
		}
		const headTreeSha =
			headProbe._tag === "Object" && headProbe.type === "tree" ? headProbe.oid : null;
		const baseTreeSha =
			baseProbe._tag === "Object" && baseProbe.type === "tree" ? baseProbe.oid : null;

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
			// (A read that FAILS also reads as "" here, and every consumer of the typo lane treats an
			// over-count by gating — fail-closed — so this one read needs no error channel.)
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

		let provenance = provenanceDefaults;
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
				// The artifact comparison only runs when the run itself resolved: the judge seats the
				// earlier provenance failures first, so an artifact read on top of them proves nothing.
				const artifact =
					token !== "" && run !== null && run.exists
						? yield* fetchReportArtifact(
								options.repo,
								validated.report.provenance.runId,
								token,
								options.apiBase ?? DEFAULT_API_BASE,
								policy.reportArtifact,
								committed ?? "",
							)
						: ({_tag: "NotChecked"} as const);
				provenance = {reachable, run, tokenPresent: token !== "", benchmarkTreeAtHeadSha, artifact};
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
		const loaded = yield* loadPolicy(root, options.baseSha, options.headSha);
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
