/**
 * `review scope` — the head SHA, the linked issue, the artifact-class partition of the PR's changed
 * files, the namespaces they require, the `self` / `harness` flags, and the `governance`
 * requirement.
 *
 * **The class rows and the namespace rows are `ship scope`'s own derivation, printed here too** —
 * `partitionWithUi` + `shipNamespacesOf`, the same objects the merge gate enforces. The two verbs
 * cannot answer differently about one file list, because there is one answer. While this side
 * partitioned without `ui`, a reviewer on a rendered diff derived `review-code` alone, PASSed, and
 * `ship gate` refused the `review-ui` namespace nobody had routed (#6664).
 *
 * The wider set does **not** widen what this gate emits. `review post`'s fence is `namespacesOf` over
 * the three text classes and is untouched, and every derived namespace this skill cannot emit is
 * re-printed on its own `routed` row — the reviewer's trigger to hand the round to `review-ui` under
 * that skill's `routed elsewhere` terminal.
 *
 * The `governance` line reads {@link touchesGovernanceRoot} over this repo's own `governedRoots` —
 * the same derivation `governance scope` prints, over the same declared list, imported rather than
 * recomputed. `harness` is three compiled-in roots and answers a different question, so a reviewer
 * who read it as the governance requirement missed one on every `.decisions/`-only diff (#5607).
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
import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {governedRootsOr} from "../config/paths.ts";
import {diffRangePaths} from "../io/git.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {
	issueRefOf,
	partition,
	partitionWithUi,
	renderIssueRef,
	routedNamespacesOf,
	shipNamespacesOf,
	touchesGovernanceRoot,
} from "./classes.ts";
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
	/** Where to look for `.fabrika.jsonc` — the checkout this run stands in. */
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export const runScope = (
	options: ScopeOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const {pr, json} = options;
		const bad = badNumber(VERB, "a pull-request number", pr);
		if (bad !== null) return bad;

		// Ahead of the PR read: a config nobody can decode has no governance answer whatever the diff
		// turns out to be, and reading the board first would spend an API call to reach that.
		const roots = yield* governedRootsOr(
			VERB,
			options.cwd,
			"the governance requirement is UNKNOWN and this partition would carry an answer nobody derived.",
		);
		if (roots._tag === "Refused") return refuse(PRECONDITION_UNKNOWN, roots.message);

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const target = yield* openPull(VERB, repo, pr, {requireOpen: true, requireFiles: true});
		if (target._tag === "Refused") return target.outcome;
		const pull = target.pull;

		const bound = yield* bindHead(VERB, repo, pr, pull, options.sha);
		if (bound._tag === "Refused") return bound.outcome;
		const head = bound.head;

		const listed = yield* diffRangePaths(head.mergeBase, head.sha);
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
			`${VERB}: governance derived over ${roots.roots.length} root(s) — ${roots.note}.`,
		];
		if (files.length !== pull.changedFiles) {
			diagnostics.push(
				`${VERB}: git and GitHub disagree on #${pr}'s file count (${files.length} vs ${pull.changedFiles}) — different merge base and different rename detection; reported, never refused on (#5154).`,
			);
		}
		if (files.length === 0) {
			return refuse(
				INCOMPLETE_SCAN,
				`${VERB}: git reports no changed files for the range ${head.mergeBase}...${head.sha}, so ${head.sha} has nothing to partition — refusing to scope an empty read (#3999).`,
				diagnostics,
			);
		}

		const flags = partition(files);
		const result = partitionWithUi(files, roots.roots);
		const namespaces = shipNamespacesOf(result);
		const routed = routedNamespacesOf(namespaces);
		const governance = touchesGovernanceRoot(files, roots.roots) ? "required" : "not-required";
		const issue = issueRefOf(pull.body);
		if (json) {
			return answer(
				JSON.stringify({
					outcome: "scoped",
					head: head.sha,
					issue,
					classes: result.classes,
					self: flags.self,
					harness: flags.harness,
					governance,
					scanned: result.scanned,
					namespaces,
					routed,
				}),
				diagnostics,
			);
		}
		return answer(
			[
				`scoped\t${head.sha}\t${renderIssueRef(issue, NULL_TOKEN)}`,
				...result.classes.map((entry) => `class\t${entry.name}\t${entry.files}`),
				...namespaces.map((namespace) => `namespace\t${namespace}`),
				...routed.map((namespace) => `routed\t${namespace}`),
				`self\t${flags.self}`,
				`harness\t${flags.harness}`,
				`governance\t${governance}`,
			].join("\n"),
			diagnostics,
		);
	});
