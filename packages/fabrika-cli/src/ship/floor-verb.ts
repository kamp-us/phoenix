/**
 * `ship floor` — the governance floor as an exit code, so a CI job can red on it.
 *
 * `ship gate` seats `blocked` at exit 0, and that is right for its interface: `blocked` is an answer
 * it proved, and a produced answer goes on 0 (`../verb.ts`). But an answer nobody reads enforces
 * nothing. When the only thing turning `blocked` into a stop was prose in the `ship` skill,
 * governance-root PRs merged with no governance verdict anyway. A workflow step cannot read
 * `gate\tblocked` on its own without deciding in bash, which shell must never do — so the decision is
 * seated here and CI relays this verb's exit code.
 *
 * **One namespace, and the resolution is `runGate`'s own.** This verb is not a second conjunction: it
 * asks `ship gate` for `governance` and reads that one line back, so there is one derivation of an
 * in-force verdict in this package and no rival answer about any other namespace. It decides nothing
 * about enqueue either — `ship gate` stays the single merge authority.
 *
 * **It refuses on WRONG, not only on MISSING.** `absent`, `stale` and `fail` all seat
 * {@link GOVERNANCE_FLOOR_UNMET}; a verdict from an author without write+ resolves `absent` through
 * the ACL gate and lands there too. Only a head-bound PASS from an authorized author is
 * satisfied.
 *
 * **What the floor is, and how it is seated, are two things.** {@link resolveFloor} answers the
 * first and nothing else; {@link runFloor} seats that answer on this verb's exit table, and
 * `./floor-check.ts` seats the same answer on a check-run. Splitting them is what lets the
 * check-run mode distinguish "not judged yet" from "judged wrong" without a second derivation of
 * the floor to disagree with this one.
 *
 * **Whether the floor binds is read off the enumerated file list, not off GitHub's `changed_files`.**
 * A list short of that declared count used to refuse at `13` on the grounds that a governance root
 * could sit in the part nobody read. The count is the stale side — GitHub computes it against a base
 * cached at the PR's last push — so the refusal blocked the merge with no act available to clear it.
 * {@link platformFileSet} owns that argument; the disagreement leaves as a `scanned` line, and the
 * empty-list refusal below is what keeps `not-required` from being answered over a diff nobody read.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9322#issuecomment-5703498377
 */
import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {governedRootsOr} from "../config/paths.ts";
import {isRecord, parseJson} from "../io/json.ts";
import {listPullFiles} from "../io/pulls.ts";
import {touchesGovernanceRoot} from "../review/classes.ts";
import {platformFileSet} from "../review/local-file-set.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {GOVERNANCE_FLOOR_UNMET, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {runGate} from "./gate-verb.ts";
import {
	badNumber,
	inspectedSha,
	NULL_TOKEN,
	resolvePull,
	resolveTargetRepo,
	scannedLine,
} from "./target.ts";

const VERB = "ship floor";

/** The one namespace the floor asks `ship gate` about. */
export const NAMESPACE = "governance";

export interface FloorOptions {
	readonly pr: number;
	readonly sha: string;
	readonly repo: string | null;
	readonly json: boolean;
	/** Where to look for `.fabrika.jsonc` — the checkout this run stands in. */
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/** What each blocking state means for the person reading a red check, and what clears it. */
const REMEDY: Readonly<Record<string, string>> = {
	absent:
		"no authorized governance verdict at this head — run the `governance` skill and emit one with `fabrika governance post`",
	stale:
		"the in-force governance verdict is bound to another head — re-judge at this head and re-post",
	fail: "the in-force governance verdict at this head is FAIL — repair the diff and re-post",
};

/**
 * The one `ns` row this verb reads out of `ship gate --json`.
 *
 * Validated rather than cast: a payload that does not carry the row is UNKNOWN, and reading a missing
 * row as anything at all is the shape that would let a parse change turn the floor off silently.
 */
const governanceState = (stdout: string): string | null => {
	const parsed = parseJson(stdout);
	if (!isRecord(parsed)) return null;
	const namespaces = parsed.namespaces;
	if (!Array.isArray(namespaces)) return null;
	for (const row of namespaces) {
		if (!isRecord(row)) continue;
		if (row.name === NAMESPACE && typeof row.state === "string") return row.state;
	}
	return null;
};

/**
 * What the floor is at one head, before any interface decides how to seat it.
 *
 * `Bound` carries the namespace state verbatim rather than a pass/blocked boolean: `absent` and
 * `fail` are one refusal on the exit table and two different conclusions on a check-run, and a type
 * that had already collapsed them could not tell them apart again.
 */
export type FloorResolution =
	/** The diff touches no governance root, so the floor does not bind — never a discharged verdict. */
	| {
			readonly _tag: "Unbound";
			readonly sha: string;
			readonly scanned: number;
			readonly stderr: ReadonlyArray<string>;
	  }
	/** The floor binds, and `ship gate` resolved `governance` to this state at this head. */
	| {
			readonly _tag: "Bound";
			readonly state: string;
			readonly sha: string;
			readonly scanned: number;
			readonly stderr: ReadonlyArray<string>;
	  }
	/** Nothing was proven. The refusal carries its own code and its own reason — UNKNOWN, never n/a. */
	| {readonly _tag: "Unresolved"; readonly outcome: VerbOutcome};

const unresolved = (outcome: VerbOutcome): FloorResolution => ({_tag: "Unresolved", outcome});

/** The floor itself, answered once, for every interface that seats it. */
export const resolveFloor = (
	options: FloorOptions,
): Effect.Effect<
	FloorResolution,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const {pr} = options;
		const bad = badNumber(VERB, "a pull-request number", pr);
		if (bad !== null) return unresolved(bad);
		const bound = inspectedSha(VERB, options.sha);
		if (typeof bound !== "string") return unresolved(bound);

		const governed = yield* governedRootsOr(
			VERB,
			options.cwd,
			'whether the floor binds is UNKNOWN, never "n/a".',
		);
		if (governed._tag === "Refused") {
			return unresolved(refuse(PRECONDITION_UNKNOWN, governed.message));
		}

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return unresolved(resolved.outcome);
		const repo = resolved.repo;

		const target = yield* resolvePull(VERB, repo, pr, {
			closedReason: "nothing to gate.",
			unknownMessage: (reason) =>
				`${VERB}: cannot read PR #${pr} in ${repo}: ${reason} — whether the floor binds is UNKNOWN, never "n/a".`,
		});
		if (target._tag === "Refused") return unresolved(target.outcome);
		const pull = target.pull;

		// The enumerated list IS the file set, and the pull-request record's `changed_files` is reported
		// beside it rather than refused on. The read stays the platform's rather than a git range
		// because `runGate` below derives the same floor off that list: two readers over two file sets
		// is the drift a single `platformFileSet` call on each side designs out.
		const listed = platformFileSet(
			VERB,
			`#${pr}`,
			pull.changedFiles,
			yield* listPullFiles(repo, pr),
		);
		if (listed._tag === "Unreadable") {
			return unresolved(
				refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read the changed-file list for #${pr}: ${listed.reason} — whether the floor binds is UNKNOWN, never "n/a".`,
				),
			);
		}
		const changed = listed.set.files;
		const scanned = [
			scannedLine(VERB, changed.length, "changed file", `${pull.changedFiles} declared`),
			...(listed.set.disagreement === null ? [] : [listed.set.disagreement]),
		];
		// Zero is the shortfall the enumeration alone establishes, and with the declared count no longer
		// refusing it is the whole floor: an empty list would answer `not-required` over a diff nobody
		// looked at.
		if (changed.length === 0) {
			return unresolved(
				refuse(
					ZERO_SCOPE,
					`${VERB}: PR #${pr} has zero changed files — whether it touches a governance root is unanswerable.`,
					scanned,
				),
			);
		}

		if (!touchesGovernanceRoot(changed, governed.roots)) {
			const clear = `${VERB}: #${pr}'s diff touches no governance root, so the floor does not bind — this is an answer about the diff, not a discharged verdict.`;
			return {
				_tag: "Unbound",
				sha: bound,
				scanned: changed.length,
				stderr: [...scanned, clear],
			};
		}

		// The floor's whole resolution — marker read, ACL gate, head-binding, in-force ordering —
		// is `ship gate`'s, asked for this one namespace. A second file read cannot loosen the
		// requirement: `--require governance` is passed because the read above already proved a
		// governance root, so a diff that changed under us still gates.
		const gated = yield* runGate({
			pr,
			sha: bound,
			require: [NAMESPACE],
			cp: false,
			repo,
			json: true,
			cwd: options.cwd,
			env: options.env,
		});
		const relayed = [...scanned, ...gated.stderr];
		if (gated.code !== 0) {
			return unresolved({...gated, stderr: relayed});
		}

		const state = governanceState(gated.stdout);
		if (state === null) {
			return unresolved(
				refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: \`ship gate\` answered without a resolvable ${NAMESPACE} row — the floor is UNKNOWN, never discharged.`,
					relayed,
				),
			);
		}
		return {_tag: "Bound", state, sha: bound, scanned: changed.length, stderr: relayed};
	});

/** Why a blocking state blocks, in the words the person reading the check needs. */
export const floorRefusalLine = (pr: number, state: string, sha: string): string =>
	`${VERB}: #${pr} touches a governance root and its ${NAMESPACE} verdict at ${sha} is ${state} — ${REMEDY[state] ?? "the floor is not discharged"}.`;

export const runFloor = (
	options: FloorOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
	Effect.map(resolveFloor(options), (resolution) => {
		if (resolution._tag === "Unresolved") return resolution.outcome;
		if (resolution._tag === "Unbound") {
			return answer(
				options.json
					? JSON.stringify({
							outcome: "n/a",
							sha: resolution.sha,
							namespace: NAMESPACE,
							state: null,
							scanned: resolution.scanned,
						})
					: `floor\tn/a\t${resolution.sha}\nns\t${NAMESPACE}\t${NULL_TOKEN}`,
				resolution.stderr,
			);
		}
		if (resolution.state !== "pass") {
			return refuse(
				GOVERNANCE_FLOOR_UNMET,
				floorRefusalLine(options.pr, resolution.state, resolution.sha),
				resolution.stderr,
			);
		}
		return answer(
			options.json
				? JSON.stringify({
						outcome: "satisfied",
						sha: resolution.sha,
						namespace: NAMESPACE,
						state: resolution.state,
						scanned: resolution.scanned,
					})
				: `floor\tsatisfied\t${resolution.sha}\nns\t${NAMESPACE}\t${resolution.state}`,
			resolution.stderr,
		);
	});
