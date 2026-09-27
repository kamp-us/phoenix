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
 * The `subsystem` rows are a third derivation, additive where the classes partition: a repo may
 * declare `reviewSubsystems` globs whose matched files each carry a constraint a reviewer applies on
 * top of the class rubric, and a path matching several globs counts under each. The rows sit between
 * the class rows and the namespace rows, sorted by subsystem name; an absent or empty key leaves the
 * output byte-identical to what it was before the key existed.
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
import type {ReviewSubsystem} from "../config/keys/review-subsystems.ts";
import {
	governedRootsOr,
	noUiSurfaces,
	reviewFilterExclusionsOr,
	reviewFilterUnexcludeOr,
	reviewSubsystemsOr,
	uiSurfacesOr,
} from "../config/paths.ts";
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
	effectiveExclusions,
	type FilterPlacement,
	governedExcluded,
	patternToMatcher,
	refusalFor,
} from "./filter-spike.ts";
import {refusalProbes} from "./guard-trees.ts";
import {bindHead, boundLine} from "./head.ts";
import {readLocalFileSet} from "./local-file-set.ts";
import {badNumber, openPull, resolveTargetRepo, scannedLine} from "./target.ts";

const VERB = "review scope";

/** The null token this group prints for a field with no value. One token, every verb. */
export const NULL_TOKEN = "-";

/** One subsystem row: how many files the subsystem's glob matched, and its constraint text. */
export interface SubsystemRow {
	readonly name: string;
	readonly files: number;
	readonly paths: ReadonlyArray<string>;
	readonly constraint: string;
}

/**
 * The `subsystem` rows over one file list: per declared subsystem, its matched-file count and its
 * constraint text.
 *
 * **Additive, never a partition.** The class map assigns each file exactly one class; these rows do
 * the opposite — a path matching several patterns counts under each subsystem, because a constraint
 * layers onto the class rubric rather than carving the diff up. A subsystem whose glob matches
 * nothing prints no row, exactly as a class with no files does; and the rows sort by subsystem name
 * so two runs cannot disagree about the order.
 */
export const subsystemRowsOf = (
	files: ReadonlyArray<string>,
	entries: ReadonlyArray<ReviewSubsystem>,
): ReadonlyArray<SubsystemRow> => {
	return entries
		.map((entry) => {
			const matcher = patternToMatcher(entry.pattern);
			const paths = files.filter((file) => matcher.test(file)).sort();
			return {name: entry.subsystem, files: paths.length, paths, constraint: entry.constraint};
		})
		.filter((row) => row.files > 0)
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
};

export interface ScopeOptions {
	readonly pr: number;
	/** The head the caller scoped. `null` binds to the PR's live head instead of asserting one. */
	readonly sha: string | null;
	readonly repo: string | null;
	readonly json: boolean;
	/** Filter content after requirement derivation; `null` leaves filtering off. */
	readonly filterPlacement?: FilterPlacement | null;
	/** comma-separated extra exclusion patterns, refused on a guard-probe match. */
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

		const subsystems = yield* reviewSubsystemsOr(
			VERB,
			options.cwd,
			"which paths carry an additive subsystem constraint is UNKNOWN and this partition would carry an answer nobody derived.",
		);
		if (subsystems._tag === "Refused") return refuse(PRECONDITION_UNKNOWN, subsystems.message);

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
			// Stated only when the key carries rows: an absent or empty list leaves this readout, and
			// the whole emission below it, byte-identical to a repo that never declared the key.
			...(subsystems.subsystems.length > 0
				? [
						`${VERB}: subsystem constraints derived over ${subsystems.subsystems.length} row(s) — ${subsystems.note}.`,
					]
				: []),
		];
		if (listed.set.disagreement !== null) diagnostics.push(listed.set.disagreement);
		if (files.length === 0) {
			return refuse(
				INCOMPLETE_SCAN,
				`${VERB}: git reports no changed files for the range ${head.mergeBase}...${head.sha}, so ${head.sha} has nothing to partition — refusing to scope an empty read.`,
				diagnostics,
			);
		}

		// Filtering changes content delivery only; all requirements use the complete path list.
		let excluded: ReadonlyArray<string> = [];
		let unexcluded: ReadonlyArray<string> = [];
		if (options.filterPlacement != null) {
			const filterExclusions = yield* reviewFilterExclusionsOr(
				VERB,
				options.cwd,
				"which globs extend the exclusion set is UNKNOWN and this partition would carry an answer nobody derived.",
			);
			if (filterExclusions._tag === "Refused") {
				return refuse(PRECONDITION_UNKNOWN, filterExclusions.message);
			}

			const filterUnexclude = yield* reviewFilterUnexcludeOr(
				VERB,
				options.cwd,
				"which defaults the exclusion set drops is UNKNOWN and this partition would carry an answer nobody derived.",
			);
			if (filterUnexclude._tag === "Refused") {
				return refuse(PRECONDITION_UNKNOWN, filterUnexclude.message);
			}
			const effective = effectiveExclusions(
				filterExclusions.exclusions,
				filterUnexclude.unexclude,
				options.exclude ?? null,
			);
			const refused = refusalFor(effective.patterns, refusalProbes(roots.roots));
			if (refused.length > 0) {
				const detail = refused
					.map((entry) =>
						entry.excludedPath !== undefined
							? `"${entry.pattern}" excludes governed path "${entry.excludedPath}"`
							: `"${entry.pattern}" matches the ${entry.guard} probe "${entry.probe}"`,
					)
					.join("; ");
				return refuse(
					GOVERNED_FILTER,
					`${VERB}: exclusion pattern intersects a governed root — ${detail}. A filter that blinds a governed surface is refused, not narrowed; guard corpora are protected by the consumer split (guards read the raw path list).`,
					diagnostics,
				);
			}
			const split = applyPlacement(files, effective.patterns);
			const governed = governedExcluded(
				split.excluded,
				effective.patterns,
				refusalProbes(roots.roots),
			);
			if (governed.length > 0) {
				return refuse(
					GOVERNED_FILTER,
					`${VERB}: the filter excludes governed content — ${governed
						.map((row) => `"${row.pattern}" excludes governed path "${row.path}"`)
						.join(
							"; ",
						)}. A filter that blinds a governed surface is refused, not narrowed; guard corpora are protected by the consumer split (guards read the raw path list).`,
					diagnostics,
				);
			}
			excluded = split.excluded;
			unexcluded = effective.unexcluded;
		}

		const flags = partition(files);
		const result = partitionWithUi(files, roots.roots, surfaces.prefixes);
		const namespaces = shipNamespacesOf(result);
		const routed = routedNamespacesOf(namespaces);
		const subsystemRows = subsystemRowsOf(files, subsystems.subsystems);
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
					...(subsystemRows.length > 0 ? {subsystems: subsystemRows} : {}),
					...(options.filterPlacement != null
						? {
								filter_placement: options.filterPlacement,
								excluded: {count: excluded.length, paths: excluded},
								...(unexcluded.length > 0
									? {unexcluded: {count: unexcluded.length, paths: unexcluded}}
									: {}),
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
				...subsystemRows.flatMap((row) => [
					`subsystem\t${row.name}\t${row.files}`,
					`subsystem-note\t${row.name}\t${row.constraint}`,
					...row.paths.map((path) => `subsystem-path\t${row.name}\t${path}`),
				]),
				...namespaces.map((namespace) => `namespace\t${namespace}`),
				...routed.map((namespace) => `routed\t${namespace}`),
				`self\t${flags.self}`,
				`harness\t${flags.harness}`,
				`governance\t${governance}`,
				...(options.filterPlacement != null
					? [
							`excluded\t${excluded.length}`,
							...excluded.map((path) => `excluded-path\t${path}`),
							// A removed default is the one exclusion nobody typed on this run's command line —
							// enumerated so the narrowed filter is stated, and only when it narrowed.
							...(unexcluded.length > 0
								? [
										`un-excluded\t${unexcluded.length}`,
										...unexcluded.map((path) => `un-excluded-path\t${path}`),
									]
								: []),
						]
					: []),
			].join("\n"),
			diagnostics,
		);
	});
