/**
 * The one ground state, pack document and GitHub / `git` script every `handoff` verb test is
 * driven from.
 *
 * Shared so the four verb suites assert against one canonical pack rather than each inventing its
 * own: a fixture per suite is how two tests come to disagree about what a well-formed pack is, and
 * the digest re-check makes that disagreement invisible until a read refuses.
 */

import type {Scripted} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {emit, instant, packNonce, groundDigest as toGroundDigest} from "../wire/handoff-pack.ts";
import {digestOf, type GroundState, renderGround} from "./ground.ts";

export const REPO = "o/r";
export const ISSUE = 5021;
export const NONCE = "7f3a9c21";
export const OTHER_NONCE = "4b8e2f01";
export const BRANCH = "umut/fanout-helper";
export const HEAD = "4f1c8a2b9d3e5607182934abcdef5566778899aa";
export const BASE = "main";
export const BASE_HEAD = "11223344556677889900aabbccddeeff00112233";
export const SEALED_AT = "2026-08-09T18:36:48Z";
export const CAPTURED_AT = "2026-08-09T18:36:48Z";
export const PULL = 5290;

const withoutDigest = {
	issue: ISSUE,
	repo: REPO,
	git: {
		branch: BRANCH,
		head: HEAD,
		upstream: `origin/${BRANCH}`,
		reachable: "pushed" as const,
		aheadBy: 0,
		behindBy: 0,
		base: {branch: BASE, head: BASE_HEAD},
		tree: {state: "clean" as const, trackedModified: 0, untracked: 0},
	},
	board: {
		issue: {state: "open", labels: ["p2", "type:chore"]},
		pull: {number: PULL, state: "open", head: HEAD, checks: "failing" as const},
	},
};

/** The worked example from the contract, with its digest computed rather than transcribed. */
export const GROUND: GroundState = {
	...withoutDigest,
	capturedAt: CAPTURED_AT,
	groundDigest: digestOf(withoutDigest),
};

const brand = <A>(value: A | null, what: string): A => {
	if (value === null) throw new Error(`fixture does not conform: ${what}`);
	return value;
};

/** The canonical pack comment, optionally with one part swapped to drive a refusal. */
export const packBody = (
	over: {
		readonly ground?: GroundState;
		readonly digest?: string;
		readonly unsure?: string;
		readonly nonce?: string;
	} = {},
): string => {
	const ground = over.ground ?? GROUND;
	return emit({
		nonce: brand(packNonce(over.nonce ?? NONCE), "nonce"),
		sealedAt: brand(instant(SEALED_AT), "sealedAt"),
		groundDigest: brand(toGroundDigest(over.digest ?? ground.groundDigest), "groundDigest"),
		intent: "Widen the fanout guard.",
		established: "The guard reads one file only; a failing case is committed.",
		nextAct: "Follow one level of local helper call, then re-run the case.",
		unsure: over.unsure ?? "Whether one level is enough.",
		groundJson: renderGround(ground),
	});
};

/**
 * The four asserted sections a caller pipes into `handoff take`.
 *
 * Byte-for-byte the four {@link packBody} composes, so a `take` driven by this stdin and a readback
 * scripted from `packBody()` are the same document — which is what lets a read-back test assert the
 * comparison rather than a rewritten copy of it.
 */
export const ASSERTED = [
	"## Intent",
	"Widen the fanout guard.",
	"",
	"## Established",
	"The guard reads one file only; a failing case is committed.",
	"",
	"## Next act",
	"Follow one level of local helper call, then re-run the case.",
	"",
	"## Unsure",
	"Whether one level is enough.",
	"",
].join("\n");

export const issueJson = (
	over: {readonly state?: string; readonly labels?: ReadonlyArray<string>} = {},
): string =>
	JSON.stringify({
		number: ISSUE,
		title: `issue ${ISSUE}`,
		body: "",
		state: over.state ?? "open",
		labels: (over.labels ?? ["p2", "type:chore"]).map((name) => ({name})),
		html_url: `https://github.com/${REPO}/issues/${ISSUE}`,
		user: {login: "usirin"},
		milestone: null,
		state_reason: null,
	});

export const commentsJson = (
	comments: ReadonlyArray<{
		readonly id: number;
		readonly body: string;
		readonly author?: string;
	}>,
): string =>
	JSON.stringify(
		comments.map((comment) => ({
			id: comment.id,
			body: comment.body,
			user: {login: comment.author ?? "usirin"},
			created_at: "2026-08-09T18:00:00Z",
			updated_at: "2026-08-09T18:00:00Z",
		})),
	);

export const pullsJson = (
	over: {readonly headSha?: string; readonly state?: string} = {},
): string =>
	JSON.stringify([
		{
			number: PULL,
			state: over.state ?? "open",
			merged_at: null,
			head: {sha: over.headSha ?? HEAD},
			created_at: "2026-08-08T10:00:00Z",
		},
	]);

export const checkRunsJson = (conclusion: string): string =>
	JSON.stringify({
		total_count: 1,
		check_runs: [{name: "ci", status: "completed", conclusion}],
	});

const okOut = (stdout: string): ExecResult => ({ok: true, stdout, reason: ""});

/** `GET https://api.github.com/repos/o/r`, and nothing under it — the default-branch read. */
export const REPO_READ = new RegExp(`GET .*/repos/${REPO}$`);

/** `GET https://api.github.com/repos/o/r/issues/5021`, and not its comments. */
export const ISSUE_READ = new RegExp(`GET .*/repos/${REPO}/issues/${ISSUE}$`);

/**
 * The whole happy-path script: the git reads rows 3-13 rest on, the board reads rows 14-19 rest on,
 * the default-branch read, and the issue itself.
 *
 * Ordered most-specific first, because both fakes resolve a call by the **first** pattern that
 * matches — the spawned command line for a git row, `METHOD <url>` for a board row.
 */
export const groundScript = (
	over: {readonly branch?: string; readonly conclusion?: string} = {},
): ReadonlyArray<Scripted> => [
	[/rev-parse --abbrev-ref --symbolic-full-name/, okOut(`origin/${over.branch ?? BRANCH}`)],
	[/rev-parse --abbrev-ref HEAD$/, okOut(over.branch ?? BRANCH)],
	[/rev-parse --verify --quiet main\^/, okOut(BASE_HEAD)],
	[/rev-parse --verify --quiet/, okOut(HEAD)],
	[/merge-base --is-ancestor/, okOut("")],
	[/rev-list --left-right --count/, okOut("0\t0")],
	[/status --porcelain/, okOut("")],
	[/rev-parse --is-inside-work-tree/, okOut("true")],
	[/check-runs/, {status: 200, body: checkRunsJson(over.conclusion ?? "failure")}],
	[/pulls\?state=all/, {status: 200, body: pullsJson()}],
	[REPO_READ, {status: 200, body: JSON.stringify({default_branch: BASE})}],
	[/collaborators\/.*\/permission/, {status: 200, body: JSON.stringify({permission: "write"})}],
	[ISSUE_READ, {status: 200, body: issueJson()}],
];
