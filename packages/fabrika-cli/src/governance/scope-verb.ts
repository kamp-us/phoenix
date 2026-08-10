/**
 * `governance scope` — whether a PR's diff derives the governance namespace, over which harness
 * roots, with the bound head, the `self` flag, and the decision records the diff touches.
 *
 * **This is not the §CP answer, and the verb says so on stderr on every run.** fabrika's §CP model is
 * CODEOWNERS-only with no semantic detection; a second answer here could contradict a merge-gating
 * verdict. What this derives is a *separate* namespace whose verdict is the skill's judgment.
 *
 * Zero changed files is a refusal, never `not-required`: the whole value of a `not-required` answer is
 * that it was computed over everything (v1's `class-probe` read 0 files and classified `has-code` at
 * exit 0 — #4060). The file list is read at the **bound commit** and the head printed is that same
 * commit, because the list is the derivation's only input (#5117).
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {diffRangeStatuses, listTreePaths} from "../io/git.ts";
import {GOVERNANCE_ROOTS} from "../review/classes.ts";
import {badNumber, openPull, resolveTargetRepo} from "../review/target.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {INCOMPLETE_SCAN, PRECONDITION_UNKNOWN} from "./codes.ts";
import {bindGovernanceHead, boundLine} from "./head.ts";
import {deriveScope} from "./roots.ts";
import {skillRootsIn} from "./skill-root.ts";

const VERB = "governance scope";

/** Printed on every run, answer or refusal — the boundary this verb is most likely to be read across. */
export const NOT_CP_NOTICE = `${VERB}: this is the governance-namespace derivation, not a §CP classification — §CP is CODEOWNERS' answer.`;

const UNKNOWN_TAIL = "the file list cannot be bound to a commit, so the derivation is UNKNOWN.";

/** The §CP boundary notice rides on refusals too — the reading it corrects is likeliest on one. */
const withNotice = (outcome: VerbOutcome): VerbOutcome => ({
	...outcome,
	stderr: [...outcome.stderr, NOT_CP_NOTICE],
});

export interface ScopeOptions {
	readonly pr: number;
	/** The head the caller scoped. `null` binds to the PR's live head instead of asserting one. */
	readonly sha: string | null;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export const runScope = (
	options: ScopeOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {pr, json} = options;
		const bad = badNumber(VERB, "a pull-request number", pr);
		if (bad !== null) return bad;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const target = yield* openPull(VERB, repo, pr, {
			requireOpen: true,
			closedReason: "nothing to derive.",
			requireFiles: true,
			emptyReason: "refusing to derive over an empty diff (ADR 0092).",
			unknownMessage: (reason) =>
				`${VERB}: cannot read PR #${pr} in ${repo}: ${reason} — whether the namespace is required is UNKNOWN, never "not-required".`,
		});
		if (target._tag === "Refused") return withNotice(target.outcome);
		const pull = target.pull;

		const bound = yield* bindGovernanceHead(VERB, UNKNOWN_TAIL, repo, pr, pull, options.sha);
		if (bound._tag === "Refused") return withNotice(bound.outcome);
		const head = bound.head;

		const listed = yield* diffRangeStatuses(head.base, head.sha);
		if (listed._tag === "Failure") {
			return withNotice(
				refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read the changed files of #${pr} at ${head.sha}: ${listed.reason} — ${UNKNOWN_TAIL}`,
				),
			);
		}
		const changed = listed.value;
		if (changed.length < pull.changedFiles) {
			// The contract seats a short read on `13` explicitly, and this stays the fail-closed
			// direction even where git and GitHub legitimately disagree — git pairs a rename into one
			// path where GitHub counts two (#5154), so a rename-only PR refuses here rather than
			// deriving from a list it cannot prove complete.
			return withNotice(
				refuse(
					INCOMPLETE_SCAN,
					`${VERB}: ${head.sha} carries ${changed.length} of the ${pull.changedFiles} files #${pr} declares — refusing to derive from a short read (#3999).`,
					[boundLine(VERB, head)],
				),
			);
		}

		const tree = yield* listTreePaths(head.sha);
		if (tree._tag === "Failure") {
			return withNotice(
				refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot list the tree at ${head.sha}: ${tree.reason} — ${UNKNOWN_TAIL}`,
				),
			);
		}

		const result = deriveScope(changed, skillRootsIn(tree.value));
		const present = GOVERNANCE_ROOTS.filter((root) =>
			tree.value.some((path) => path.startsWith(root)),
		);
		const diagnostics = [
			boundLine(VERB, head),
			...GOVERNANCE_ROOTS.filter((root) => !present.includes(root)).map(
				(root) =>
					`${VERB}: root ${root} is absent in this repository — the derivation covered ${present.length} of ${GOVERNANCE_ROOTS.length} roots.`,
			),
			`${VERB}: partitioned ${changed.length} of the ${pull.changedFiles} declared changed files at ${head.sha} across ${GOVERNANCE_ROOTS.length} roots.`,
			NOT_CP_NOTICE,
		];

		const outcome = result.required ? "required" : "not-required";
		if (json) {
			return answer(
				JSON.stringify({
					outcome,
					head: head.sha,
					roots: result.roots.map((tally) => ({name: tally.name, files: tally.files})),
					self: result.self,
					base: head.base,
					records: result.records,
					scanned: result.scanned,
				}),
				diagnostics,
			);
		}
		return answer(
			[
				`governance\t${outcome}\t${head.sha}`,
				...result.roots.map((tally) => `root\t${tally.name}\t${tally.files}`),
				`self\t${result.self}`,
				...result.records.map((row) => `record\t${row.id}\t${row.change}\t${row.path}`),
			].join("\n"),
			diagnostics,
		);
	});
