/**
 * `review scope` — the head SHA, the linked issue, the artifact-class partition of the PR's changed
 * files, the namespaces they require, the `self` / `harness` flags, and the `governance`
 * requirement.
 *
 * **The class rows and the namespace rows are `ship scope`'s own derivation, printed here too** —
 * `partitionWithUi` + `shipNamespacesOf`, the same objects the merge gate enforces. The two verbs
 * cannot answer differently about one file list, because there is one answer. While this side
 * partitioned without `ui`, a reviewer on a rendered diff derived `review-code` alone, PASSed, and
 * `ship gate` refused the `review-ui` namespace nobody had routed.
 *
 * The wider set does **not** widen what this gate emits. `review post`'s fence is `namespacesOf` over
 * the three text classes and is untouched, and every derived namespace this skill cannot emit is
 * re-printed on its own `routed` row — the reviewer's trigger to hand the round to `review-ui` under
 * that skill's `routed elsewhere` terminal.
 *
 * The `governance` line reads {@link touchesGovernanceRoot} over this repo's own `governedRoots` —
 * the same derivation `governance scope` prints, over the same declared list, imported rather than
 * recomputed. `harness` is three compiled-in roots and answers a different question, so a reviewer
 * who read it as the governance requirement missed one on every decision-corpus-only diff.
 *
 * The refusals are the point: the partition is total over **what was read**, so the verb exists to
 * make sure it is never run over less than everything. A PR GitHub reports as having zero changed
 * files reds on `7` (v1's `class-probe` read 0 files and classified `has-code` exit 0), and
 * a git read that comes back empty reds on `13` — either way there is nothing to partition.
 *
 * Empty is the whole of it. This path list IS the scope, so no second count of the same range exists
 * to call it short against, and GitHub's `changed_files` is not one: a disagreement with it is
 * reported and never refused on. That read is {@link readLocalFileSet}, shared with
 * `governance scope` and `governance guards` so the three cannot state different facts about one
 * disagreement; its docblock carries why.
 *
 * The file list is read at the **bound commit** (`head.ts`), and the head this verb prints is that
 * same commit. The namespace set is documented as both floor and ceiling, so a list drawn from a
 * different commit than the printed head derives a namespace nobody judged — or drops one.
 */
import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {governedRootsOr, noUiSurfaces, uiSurfacesOr} from "../config/paths.ts";
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
import {GOVERNED_FILTER, INCOMPLETE_SCAN, PRECONDITION_UNKNOWN} from "./codes.ts";
import {
	applyPlacement,
	DEFAULT_EXCLUSIONS,
	type FilterPlacement,
	parseExcludeList,
	refusalFor,
} from "./filter-spike.ts";
import {refusalProbes} from "./guard-trees.ts";
import {bindHead, boundLine} from "./head.ts";
import {readLocalFileSet} from "./local-file-set.ts";
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
	/** ocr-port spike: `before` filters then derives, `after` derives then marks, `null` = off. */
	readonly filterPlacement?: FilterPlacement | null;
	/** ocr-port spike: comma-separated extra exclusion patterns, refused on a guard-probe match. */
	readonly exclude?: string | null;
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

		const surfaces = yield* uiSurfacesOr(
			VERB,
			options.cwd,
			"which paths raise the ui class is UNKNOWN and this partition would carry an answer nobody derived.",
		);
		if (surfaces._tag === "Refused") return refuse(PRECONDITION_UNKNOWN, surfaces.message);

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const target = yield* openPull(VERB, repo, pr, {requireOpen: true, requireFiles: true});
		if (target._tag === "Refused") return target.outcome;
		const pull = target.pull;

		const bound = yield* bindHead(VERB, repo, pr, pull, options.sha);
		if (bound._tag === "Refused") return bound.outcome;
		const head = bound.head;

		// This list IS the scope, so there is no second local count to prove it against — and
		// GitHub's `changed_files` is not one, which is why `readLocalFileSet` reports that
		// disagreement instead of refusing on it. The short read git alone establishes — an empty
		// list — still refuses, below.
		const listed = yield* readLocalFileSet(
			VERB,
			`#${pr}`,
			{base: head.mergeBase, tip: head.sha},
			pull.changedFiles,
			diffRangePaths,
		);
		if (listed._tag === "Unreadable") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the changed files of #${pr} at ${head.sha}: ${listed.reason} — the scope is UNKNOWN.`,
			);
		}
		const files = listed.set.files;
		const diagnostics = [
			boundLine(VERB, head),
			scannedLine(VERB, files.length, "changed file", `${pull.changedFiles} declared by GitHub`),
			`${VERB}: governance derived over ${roots.roots.length} root(s) — ${roots.note}.`,
			surfaces.prefixes.length === 0
				? noUiSurfaces(VERB)
				: `${VERB}: ui derived over ${surfaces.prefixes.length} prefix(es) — ${surfaces.note}.`,
		];
		if (listed.set.disagreement !== null) diagnostics.push(listed.set.disagreement);
		if (files.length === 0) {
			return refuse(
				INCOMPLETE_SCAN,
				`${VERB}: git reports no changed files for the range ${head.mergeBase}...${head.sha}, so ${head.sha} has nothing to partition — refusing to scope an empty read.`,
				diagnostics,
			);
		}

		// Review diff filtering: the exclusion split runs after the empty-read refusal above, and
		// the placement decides what the partition derives over — `before` the kept paths, `after`
		// the full read. The refusal union is `governedRoots`, derived per run; guard trigger trees
		// stay documented and drift-loud by the golden test, not protected by refusal.
		let excluded: ReadonlyArray<string> = [];
		let partitionSource = files;
		if (options.filterPlacement != null) {
			const patterns = [
				...DEFAULT_EXCLUSIONS,
				...(options.exclude == null ? [] : parseExcludeList(options.exclude)),
			];
			const refused = refusalFor(patterns, refusalProbes(roots.roots));
			if (refused.length > 0) {
				const detail = refused
					.map((entry) => `"${entry.pattern}" matches the ${entry.guard} probe "${entry.probe}"`)
					.join("; ");
				return refuse(
					GOVERNED_FILTER,
					`${VERB}: exclusion pattern intersects a governed root — ${detail}. A filter that blinds a governed surface is refused, not narrowed; guard corpora are protected by the consumer split (guards read the raw path list).`,
					diagnostics,
				);
			}
			const split = applyPlacement(files, patterns);
			excluded = split.excluded;
			partitionSource = options.filterPlacement === "before" ? split.kept : files;
		}

		const flags = partition(partitionSource);
		const result = partitionWithUi(partitionSource, roots.roots, surfaces.prefixes);
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
					...(options.filterPlacement != null
						? {
								filter_placement: options.filterPlacement,
								excluded: {count: excluded.length, paths: excluded},
							}
						: {}),
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
				...(options.filterPlacement != null
					? [`excluded\t${excluded.length}`, ...excluded.map((path) => `excluded-path\t${path}`)]
					: []),
			].join("\n"),
			diagnostics,
		);
	});
