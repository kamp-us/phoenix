/**
 * `governance scope` — whether a diff derives the governance namespace, over which harness roots,
 * with the bound head, the `self` flag, and the decision records the diff touches.
 *
 * **This is not the §CP answer, and the verb says so on stderr on every run.** fabrika's §CP model is
 * CODEOWNERS-only with no semantic detection; a second answer here could contradict a merge-gating
 * verdict. What this derives is a *separate* namespace whose verdict is the skill's judgment.
 *
 * Zero changed files is a refusal, never `not-required`: the whole value of a `not-required` answer is
 * that it was computed over everything (v1's `class-probe` read 0 files and classified `has-code` at
 * exit 0 — #4060). The file list is read at the **bound commit** and the head printed is that same
 * commit, because the list is the derivation's only input (#5117).
 *
 * **With `--base`/`--tip` the subject is a range instead of a pull request (#6064).** An epic child
 * has no PR mid-run (ADR 0285), so without that form §1 of the skill is unrunnable on what ADR 0293
 * makes the normal path for every `claude-plugins/**` child — and `self`, which only this verb
 * derives, is the self fence's own precondition. Both modes read the same three-dot range and refuse
 * the same three ways: unreadable is UNKNOWN, empty and provably short are refusals, and none of the
 * three is ever `not-required`.
 */
import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {governedRootsOr} from "../config/paths.ts";
import {
	type ChangedPath,
	type CommitRange,
	diffRangePaths,
	diffRangeStatuses,
	listTreePaths,
} from "../io/git.ts";
import {rangeMergeBase, readRangeFlags} from "../review/range-flags.ts";
import {badNumber, openPull, resolveTargetRepo} from "../review/target.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import type {HeadSha} from "../wire/marker-line.ts";
import {renderRange} from "../wire/range-verdict-marker.ts";
import {INCOMPLETE_SCAN, OFF_VOCABULARY, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
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
	/** The pull request to derive over — `null` only in range mode, which resolves no PR at all. */
	readonly pr: number | null;
	/** The head the caller scoped. `null` binds to the PR's live head instead of asserting one. */
	readonly sha: string | null;
	/** The two ends of a range-scoped derivation — both or neither, and never beside `--sha`. */
	readonly base: string | null;
	readonly tip: string | null;
	readonly repo: string | null;
	readonly json: boolean;
	/** Where to look for `.fabrika.jsonc` — the checkout this run stands in. */
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * What the derivation runs on, however the subject was named: the changed paths, the commit whose
 * tree resolves the skill roots and the root presence, the base those paths were read across, and
 * the count a *second* enumeration of the same subject declares them at.
 */
interface Subject {
	readonly changed: ReadonlyArray<ChangedPath>;
	readonly treeSha: string;
	readonly base: string;
	readonly declared: number;
	/** How the answer and its diagnostics name this subject — a head SHA, or `<base>..<tip>`. */
	readonly named: string;
	/** The evidence line every answer and every later refusal carries. */
	readonly bound: string;
}

type Resolved =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| {readonly _tag: "Subject"; readonly subject: Subject};

const refused = (
	code: number,
	message: string,
	diagnostics: ReadonlyArray<string> = [],
): Resolved => ({_tag: "Refused", outcome: refuse(code, message, diagnostics)});

/** The subject a pull-request number names: the diff of its bound head against its merge base. */
const pullSubject = (
	options: ScopeOptions,
	pr: number,
): Effect.Effect<Resolved, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return {_tag: "Refused" as const, outcome: resolved.outcome};
		const repo = resolved.repo;

		const target = yield* openPull(VERB, repo, pr, {
			requireOpen: true,
			closedReason: "nothing to derive.",
			requireFiles: true,
			emptyReason: "refusing to derive over an empty diff (ADR 0092).",
			unknownMessage: (reason) =>
				`${VERB}: cannot read PR #${pr} in ${repo}: ${reason} — whether the namespace is required is UNKNOWN, never "not-required".`,
		});
		if (target._tag === "Refused") return {_tag: "Refused" as const, outcome: target.outcome};
		const pull = target.pull;

		const bound = yield* bindGovernanceHead(VERB, UNKNOWN_TAIL, repo, pr, pull, options.sha);
		if (bound._tag === "Refused") return {_tag: "Refused" as const, outcome: bound.outcome};
		const head = bound.head;

		const listed = yield* diffRangeStatuses(head.mergeBase, head.sha);
		if (listed._tag === "Failure") {
			return refused(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the changed files of #${pr} at ${head.sha}: ${listed.reason} — ${UNKNOWN_TAIL}`,
			);
		}
		if (listed.value.length < pull.changedFiles) {
			// The contract seats a short read on `13` explicitly, and this stays the fail-closed
			// direction even where git and GitHub legitimately disagree — git pairs a rename into one
			// path where GitHub counts two (#5154), so a rename-only PR refuses here rather than
			// deriving from a list it cannot prove complete.
			return refused(
				INCOMPLETE_SCAN,
				`${VERB}: ${head.sha} carries ${listed.value.length} of the ${pull.changedFiles} files #${pr} declares — refusing to derive from a short read (#3999).`,
				[boundLine(VERB, head)],
			);
		}
		return {
			_tag: "Subject" as const,
			subject: {
				changed: listed.value,
				treeSha: head.sha,
				base: head.mergeBase,
				declared: pull.changedFiles,
				named: head.sha,
				bound: boundLine(VERB, head),
			},
		};
	});

/**
 * The subject a range names — the same three-dot diff, with no PR anywhere in the resolution.
 *
 * The declared count comes from a **second, independent enumeration** of the same range
 * (`--name-only` beside `--name-status`), which is what a PR's `changedFiles` supplies on the other
 * path. It is not ceremony: `parseNameStatus` walks a rename's three fields where every other change
 * carries two, so a truncated or unpaired stream stops the walk early and yields a well-formed but
 * short list. Comparing it against a read that cannot fail that way is what turns that into a `13`
 * instead of a confident derivation over half a diff.
 */
const rangeSubject = (
	range: CommitRange<HeadSha>,
): Effect.Effect<Resolved, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const named = renderRange(range);
		// See `../review/range-flags.ts` for why this — and not either end — is the range's base.
		const base = yield* rangeMergeBase(range);
		if (base._tag === "Failure") {
			return refused(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot resolve the merge base of ${named}: ${base.reason} — ${UNKNOWN_TAIL}`,
			);
		}
		const bound = `${VERB}: bound to ${range.tip} (base ${base.value}) — read from the object database, nothing checked out.`;

		const listed = yield* diffRangeStatuses(range.base, range.tip);
		if (listed._tag === "Failure") {
			return refused(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the changed files of ${named}: ${listed.reason} — ${UNKNOWN_TAIL}`,
				[bound],
			);
		}
		const declared = yield* diffRangePaths(range.base, range.tip);
		if (declared._tag === "Failure") {
			return refused(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot enumerate the paths of ${named}: ${declared.reason} — ${UNKNOWN_TAIL}`,
				[bound],
			);
		}
		if (declared.value.length === 0) {
			return refused(
				ZERO_SCOPE,
				`${VERB}: ${named} changes no path — refusing to derive over an empty diff (ADR 0092).`,
				[bound],
			);
		}
		if (listed.value.length < declared.value.length) {
			return refused(
				INCOMPLETE_SCAN,
				`${VERB}: ${named} carries ${listed.value.length} of the ${declared.value.length} files its ends change — refusing to derive from a short read (#3999).`,
				[bound],
			);
		}
		return {
			_tag: "Subject" as const,
			subject: {
				changed: listed.value,
				treeSha: range.tip,
				base: base.value,
				declared: declared.value.length,
				named,
				bound,
			},
		};
	});

export const runScope = (
	options: ScopeOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const {pr, json} = options;

		const flags = readRangeFlags(VERB, {base: options.base, tip: options.tip, sha: options.sha});
		if (flags._tag === "Refused") return withNotice(flags.outcome);

		const governed = yield* governedRootsOr(
			VERB,
			options.cwd,
			'the root set is UNKNOWN and the derivation is never "not-required".',
		);
		if (governed._tag === "Refused") {
			return withNotice(refuse(PRECONDITION_UNKNOWN, governed.message));
		}
		const governedRoots = governed.roots;

		let resolved: Resolved;
		if (flags._tag === "Ranged") {
			if (pr !== null) {
				return withNotice(
					refuse(
						OFF_VOCABULARY,
						`${VERB}: a range is its own subject — drop the pull-request number, or drop --base/--tip.`,
					),
				);
			}
			resolved = yield* rangeSubject(flags.range);
		} else {
			if (pr === null) {
				return withNotice(
					refuse(
						OFF_VOCABULARY,
						`${VERB}: name a pull request, or scope a range with --base and --tip — there is no subject here.`,
					),
				);
			}
			const bad = badNumber(VERB, "a pull-request number", pr);
			if (bad !== null) return bad;
			resolved = yield* pullSubject(options, pr);
		}
		if (resolved._tag === "Refused") return withNotice(resolved.outcome);
		const {changed, treeSha, base, declared, named, bound} = resolved.subject;

		const tree = yield* listTreePaths(treeSha);
		if (tree._tag === "Failure") {
			return withNotice(
				refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot list the tree at ${treeSha}: ${tree.reason} — ${UNKNOWN_TAIL}`,
				),
			);
		}

		const result = deriveScope(changed, skillRootsIn(tree.value), governedRoots);
		const present = governedRoots.filter((root) =>
			tree.value.some((path) => path.startsWith(root)),
		);
		const diagnostics = [
			bound,
			`${VERB}: root set is ${governed.note}.`,
			...governedRoots
				.filter((root) => !present.includes(root))
				.map(
					(root) =>
						`${VERB}: root ${root} is absent in this repository — the derivation covered ${present.length} of ${governedRoots.length} roots.`,
				),
			`${VERB}: partitioned ${changed.length} of the ${declared} declared changed files at ${named} across ${governedRoots.length} roots.`,
			NOT_CP_NOTICE,
		];

		const outcome = result.required ? "required" : "not-required";
		if (json) {
			return answer(
				JSON.stringify({
					outcome,
					// A range has no head, so this field carries whatever named the subject — a head SHA
					// on the PR path, `<base>..<tip>` on the range path, matching `governance post`'s
					// third field in each mode.
					head: named,
					roots: result.roots,
					self: result.self,
					base,
					records: result.records,
					scanned: result.scanned,
				}),
				diagnostics,
			);
		}
		return answer(
			[
				`governance\t${outcome}\t${named}`,
				...Object.entries(result.roots).map(([name, files]) => `root\t${name}\t${files}`),
				`self\t${result.self}`,
				...result.records.map((row) => `record\t${row.id}\t${row.change}\t${row.path}`),
			].join("\n"),
			diagnostics,
		);
	});
