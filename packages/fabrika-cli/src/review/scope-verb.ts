/**
 * `review scope` — the head SHA, the linked issue, the artifact-class partition of the PR's changed
 * files, and the `self` / `harness` flags.
 *
 * The refusals are the point: the partition is total over **what was read**, so the verb exists to
 * make sure it is never run over less than everything. A PR GitHub reports as having zero changed
 * files reds on `7` (v1's `class-probe` read 0 files and classified `has-code` exit 0 — #4060), and
 * a git read that comes back empty reds on `13` — either way there is nothing to partition (#3999).
 *
 * Empty is the whole of it. This path list IS the scope, so no second count of the same range exists
 * to call it short against, and GitHub's `changed_files` is not one: a disagreement with it is
 * reported and never refused on (#5154 — the reason is at the check below).
 *
 * The file list is read at the **bound commit** (`head.ts`), and the head this verb prints is that
 * same commit. The namespace set is documented as both floor and ceiling, so a list drawn from a
 * different commit than the printed head derives a namespace nobody judged — or drops one (#5117).
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {diffRangePaths} from "../io/git.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {issueRefOf, namespacesOf, partition, renderIssueRef} from "./classes.ts";
import {INCOMPLETE_SCAN, PRECONDITION_UNKNOWN} from "./codes.ts";
import {bindHead, boundLine} from "./head.ts";
import {badNumber, openPull, resolveTargetRepo, scannedLine} from "./target.ts";

const VERB = "review scope";

/** The null token this group prints for a field with no value. One token, every verb. */
export const NULL_TOKEN = "-";

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

		const target = yield* openPull(VERB, repo, pr, {requireOpen: true, requireFiles: true});
		if (target._tag === "Refused") return target.outcome;
		const pull = target.pull;

		const bound = yield* bindHead(VERB, repo, pr, pull, options.sha);
		if (bound._tag === "Refused") return bound.outcome;
		const head = bound.head;

		const listed = yield* diffRangePaths(head.base, head.sha);
		if (listed._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the changed files of #${pr} at ${head.sha}: ${listed.reason} — the scope is UNKNOWN.`,
			);
		}
		// This list IS the scope, so there is no second local count to prove it against — and
		// GitHub's `changed_files` is not one: a rename git pairs into a single `--name-only` path
		// while GitHub counts two files, so it is reported below and never refused on (#5154). The
		// short read git alone establishes — an empty list — still refuses.
		const files = listed.value;
		const diagnostics = [
			boundLine(VERB, head),
			scannedLine(VERB, files.length, "changed file", `${pull.changedFiles} declared by GitHub`),
		];
		if (files.length !== pull.changedFiles) {
			diagnostics.push(
				`${VERB}: git and GitHub disagree on #${pr}'s file count (${files.length} vs ${pull.changedFiles}) — different merge base and different rename detection; reported, never refused on (#5154).`,
			);
		}
		if (files.length === 0) {
			return refuse(
				INCOMPLETE_SCAN,
				`${VERB}: git reports no changed files for the range ${head.base}...${head.sha}, so ${head.sha} has nothing to partition — refusing to scope an empty read (#3999).`,
				diagnostics,
			);
		}

		const result = partition(files);
		const issue = issueRefOf(pull.body);
		if (json) {
			return answer(
				JSON.stringify({
					outcome: "scoped",
					head: head.sha,
					issue,
					classes: result.classes,
					self: result.self,
					harness: result.harness,
					scanned: result.scanned,
					namespaces: namespacesOf(result),
				}),
				diagnostics,
			);
		}
		return answer(
			[
				`scoped\t${head.sha}\t${renderIssueRef(issue, NULL_TOKEN)}`,
				...result.classes.map((entry) => `class\t${entry.name}\t${entry.files}`),
				`self\t${result.self}`,
				`harness\t${result.harness}`,
			].join("\n"),
			diagnostics,
		);
	});
