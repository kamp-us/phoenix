/**
 * `build resume-child` — an epic child's standing-`FAIL` repair entry, as one operation.
 *
 * The five steps a child repair opens with are ordered, and until now the order lived in prose: claim
 * the repair lane, re-prove that claim, prove the generic checkout clean, re-key and check out the
 * branch the prior lane built, and only then arm the lane-identity proof. A resumed builder that ran
 * the armed `tree --issue` before `branch --resume-lane` had its own generic checkout refused on exit
 * `14` and parked the whole epic (#7187) — the cost a documented order can always carry.
 *
 * It sequences and derives nothing. Every step is the verb a builder would have typed, called through
 * the same `run*` function the CLI calls, so each refusal keeps its own exit code, its own words and
 * its own fail-closed reading; this module adds only the line naming which step stopped.
 */
import {Effect, type FileSystem, type Path} from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {isRecord, parseJson} from "../io/json.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {runBranch} from "./branch-verb.ts";
import {runClaim, runConfirm} from "./claim-verb.ts";
import {PRECONDITION_UNKNOWN} from "./codes.ts";
import {runTree} from "./tree-verb.ts";

const VERB = "build resume-child";

export interface ResumeChildOptions {
	/** The epic child being repaired. Never a PR: a child opens none (ADR 0285). */
	readonly issue: number;
	/**
	 * The repair claim this lane already holds, when it is re-running — `null` on a first entry.
	 *
	 * Passed straight to `build claim`, which answers `won` off the standing marker and writes nothing
	 * when the token names this lane, so a re-run after a mid-sequence refusal costs no second marker.
	 */
	readonly token: string | null;
	readonly repo: string | null;
	/** Where to look for `ROADMAP.md` — the checkout this run stands in. */
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly uuid: string;
	readonly at: string;
}

type Requirements =
	| ChildProcessSpawner.ChildProcessSpawner
	| HttpClient.HttpClient
	| FileSystem.FileSystem
	| Path.Path;

/**
 * Re-emit a composed verb's refusal, naming the step it stopped at.
 *
 * The step line goes FIRST and the composed verb's own stderr last, so the final line of a refusal is
 * still the reason the verb that proved it wrote — the line every caller of this group reads.
 */
const stopped = (
	step: string,
	outcome: VerbOutcome,
	notes: ReadonlyArray<string>,
	trailer: ReadonlyArray<string> = [],
): VerbOutcome => ({
	code: outcome.code,
	stdout: "",
	stderr: [
		...notes,
		`${VERB}: stopped at the ${step} step on exit ${outcome.code}; the steps after it did not run.`,
		...trailer,
		...outcome.stderr,
	],
});

/** One field off a composed verb's JSON answer, or `null` when the answer is not the documented shape. */
const field = (stdout: string, name: string): unknown => {
	const parsed = parseJson(stdout);
	return isRecord(parsed) ? (parsed[name] ?? null) : null;
};

export const runResumeChild = (
	options: ResumeChildOptions,
): Effect.Effect<VerbOutcome, never, Requirements> =>
	Effect.gen(function* () {
		const {issue, repo, env} = options;

		// `--resume` is what makes this a repair rather than a rebuild, and `build claim` checks it
		// against the child's own standing verdicts: no standing FAIL refuses on 31 here, before any
		// marker, so the entry cannot open a repair lane over a child nobody failed.
		const claimed = yield* runClaim({
			number: issue,
			repo,
			cwd: options.cwd,
			env,
			uuid: options.uuid,
			at: options.at,
			purpose: "build",
			override: null,
			overrideLane: null,
			cites: null,
			token: options.token,
			resume: true,
		});
		if (claimed.code !== 0) return stopped("claim", claimed, []);
		const won = field(claimed.stdout, "token");
		if (typeof won !== "string" || won === "") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: "build claim ${issue} --resume" answered without a readable token — which lane holds the repair is UNKNOWN, so nothing was checked out. Read the claim state with "fabrika build claimants ${issue}" before re-running.`,
				claimed.stderr,
			);
		}
		const notes = [...claimed.stderr];
		// Every refusal past this point leaves a marker on the board, and a lane that cannot say how to
		// retract it is how a child ends up claimed by nobody who is still running.
		const held = [
			`${VERB}: the repair claim on #${issue} stands — re-run this verb to continue it, or retract it with "fabrika build release ${issue} --token ${won}".`,
		];

		const confirmed = yield* runConfirm({number: issue, repo, env, token: won});
		if (confirmed.code !== 0) return stopped("confirm", confirmed, notes, held);
		notes.push(...confirmed.stderr);

		// Unarmed on purpose: no lane branch is checked out yet, so there is no lane identity to prove
		// and asking for one here is the very inversion this verb exists to make unavailable.
		const clean = yield* runTree({requireClean: true, issue: null, repair: null, repo, env});
		if (clean.code !== 0) return stopped("clean-tree", clean, notes, held);
		notes.push(...clean.stderr);

		const branched = yield* runBranch({
			number: issue,
			slug: null,
			base: "origin/main",
			resume: null,
			resumeLane: true,
			token: won,
			repo,
			env,
		});
		if (branched.code !== 0) return stopped("resume-lane", branched, notes, held);
		notes.push(...branched.stderr);
		const branch = branched.stdout.trim();

		const proven = yield* runTree({requireClean: false, issue, repair: null, repo, env});
		if (proven.code !== 0) return stopped("armed-tree", proven, notes, held);
		notes.push(...proven.stderr);
		const root = field(proven.stdout, "root");
		const claim = field(proven.stdout, "claim");
		if (typeof root !== "string" || claim === null) {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: "build tree --issue ${issue}" answered without a readable proof — ${branch} is checked out and whether it carries this claim's identity is UNKNOWN. Re-run "fabrika build tree --issue ${issue}" before mutating anything.`,
				[...notes, ...held],
			);
		}

		return answer(JSON.stringify({answer: "resumed", issue, token: won, branch, root, claim}), [
			...notes,
			`${VERB}: #${issue}'s repair lane is open on ${branch}, proven against the claim it carries — read the findings with "fabrika build verdicts --issue ${issue}", then fix, "build check" and "build commit" on this branch. A child opens no PR: it ends on the build-deviations comment and BUILT-NO-PR.`,
		]);
	});
