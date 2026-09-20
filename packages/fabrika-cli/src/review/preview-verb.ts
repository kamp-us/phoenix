/**
 * `review preview` — the read-only path extraction behind review diff filtering: matched paths,
 * exclusions, and the active class partition at the requested filter placement, with the filtered
 * diff available on the same answer. No LLM, no write. Three subjects, mutually exclusive, in
 * parity with the group's other read verbs: `--diff-file <path>` reads a unified diff on disk (no
 * PR, no network); a pull-request number, with optional `--sha`/`--repo`, binds a head
 * (`./head.ts`) and reads the PR's three-dot diff out of the object database exactly as
 * `review diff` does; `--base`/`--tip` names a range (`./range-flags.ts`), whose diff is taken
 * from the range's own merge base — the same commit `./content-binding.ts` digests.
 *
 * **A short read never reaches the filter.** Every subject proves completeness the same way:
 * `./diff.ts`'s `filesInDiff` against `diffRangePaths` over ONE range, both operands from git, so
 * a diff carrying fewer files than git lists for the same range refuses `INCOMPLETE_SCAN` before
 * the exclusion set is applied — a deliberate exclusion can never masquerade as a truncation, and
 * the `x-fabrika-filter`, `x-fabrika-excluded-path` and `x-fabrika-unexcluded-path` headers name
 * only what was left out on purpose. The set itself is the effective one: the shipped defaults,
 * minus what `.fabrika.jsonc`'s `reviewFilterUnexclude` removes, plus what its
 * `reviewFilterExclusions` and `--exclude` add — a removed default nothing re-added is enumerated
 * (`un-excluded` rows, the `unexcluded` JSON field, the diff header) so a narrowed filter is
 * stated, never silent.
 *
 * Refusal mapping: a placement off the two-value vocabulary, two subjects at once, or a PR-subject
 * modifier beside a subject that binds no head seats on `OFF_VOCABULARY` — a modifier that would
 * be silently ignored is refused instead; an exclusion pattern matching a governed root seats on
 * `GOVERNED_FILTER` (the hard invariant); an unreadable diff file, an unreadable git read, or a
 * subject that cannot be bound is `PRECONDITION_UNKNOWN` — never a permissive empty read.
 */
import {readFileSync} from "node:fs";
import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {
	governedRootsOr,
	reviewFilterExclusionsOr,
	reviewFilterUnexcludeOr,
} from "../config/paths.ts";
import {diffRange, diffRangePaths} from "../io/git.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {GOVERNED_FILTER, INCOMPLETE_SCAN, OFF_VOCABULARY, PRECONDITION_UNKNOWN} from "./codes.ts";
import {filesInDiff} from "./diff.ts";
import {effectiveExclusions, isFilterPlacement, previewOf} from "./filter-spike.ts";
import {refusalProbes} from "./guard-trees.ts";
import {bindHead, boundLine} from "./head.ts";
import {rangeMergeBase, readRangeFlags} from "./range-flags.ts";
import {badNumber, openPull, resolveTargetRepo} from "./target.ts";

const VERB = "review preview";

const SUBJECTS = "--diff-file <path>, a pull-request number, or --base/--tip";

export interface PreviewOptions {
	/** Subject one: a unified diff on local disk — no PR, no network. */
	readonly diffFile: string | null;
	/** Subject two: the PR number; `--sha` and `--repo` are its modifiers. `null` names no PR. */
	readonly pr?: number | null;
	/** The head the caller scoped. `null` binds to the PR's live head instead of asserting one. */
	readonly sha?: string | null;
	/** The target `owner/name`; `null` resolves from the env, else the origin remote. */
	readonly repo?: string | null;
	/** Subject three's two ends — together or neither; `--sha` never beside them (range-flags.ts). */
	readonly base?: string | null;
	readonly tip?: string | null;
	/** `null` (flag omitted) is refused — the verb exists to compare the two placements. */
	readonly filterPlacement: string | null;
	/** Comma-separated extra patterns; blanks dropped. Refused when one matches a guard probe. */
	readonly exclude: string | null;
	readonly emitDiff: boolean;
	readonly json: boolean;
	/** Where to look for `.fabrika.jsonc` — the governed roots half of the refusal union. */
	readonly cwd: string;
	/** The env `--repo` resolution falls back to. `null`/omitted means an empty one. */
	readonly env?: Readonly<Record<string, string | undefined>>;
}

export const runPreview = (
	options: PreviewOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const placement = options.filterPlacement;
		if (placement === null) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --filter-placement is required — the verb compares \`before\` and \`after\` only`,
			);
		}
		if (!isFilterPlacement(placement)) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --filter-placement must be \`before\` or \`after\`, got "${placement}"`,
			);
		}
		if (options.emitDiff && options.json) {
			return refuse(OFF_VOCABULARY, `${VERB}: --emit-diff and --json are mutually exclusive`);
		}

		const diffFile = options.diffFile ?? null;
		const pr = options.pr ?? null;
		const sha = options.sha ?? null;
		const repo = options.repo ?? null;
		const base = options.base ?? null;
		const tip = options.tip ?? null;

		const named = [
			...(diffFile !== null ? ["--diff-file"] : []),
			...(pr !== null ? ["a pull-request number"] : []),
			...(base !== null || tip !== null ? ["--base/--tip"] : []),
		];
		if (named.length > 1) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: ${named[0]} and ${named[1]} name two subjects — pass exactly one of ${SUBJECTS}.`,
			);
		}
		if (named.length === 0) {
			return refuse(OFF_VOCABULARY, `${VERB}: name exactly one subject — ${SUBJECTS}.`);
		}

		const roots = yield* governedRootsOr(
			VERB,
			options.cwd,
			"the refusal union is UNKNOWN without the governed roots, and an UNKNOWN union refuses nothing.",
		);
		if (roots._tag === "Refused") return refuse(PRECONDITION_UNKNOWN, roots.message);

		const filterExclusions = yield* reviewFilterExclusionsOr(
			VERB,
			options.cwd,
			"which globs extend the exclusion set is UNKNOWN and this preview would carry a set nobody derived.",
		);
		if (filterExclusions._tag === "Refused") {
			return refuse(PRECONDITION_UNKNOWN, filterExclusions.message);
		}
		const filterUnexclude = yield* reviewFilterUnexcludeOr(
			VERB,
			options.cwd,
			"which defaults the exclusion set drops is UNKNOWN and this preview would carry a set nobody derived.",
		);
		if (filterUnexclude._tag === "Refused") {
			return refuse(PRECONDITION_UNKNOWN, filterUnexclude.message);
		}

		const effective = effectiveExclusions(
			filterExclusions.exclusions,
			filterUnexclude.unexclude,
			options.exclude,
		);
		const patterns = effective.patterns;
		const probes = refusalProbes(roots.roots);

		/**
		 * The subject-independent tail: the governed-filter refusal, then the three emission arms,
		 * each carrying the subject's provenance on stderr. `previewOf` runs the refusal union
		 * strictly after the completeness proof every subject has already passed above, so the
		 * exclusion headers answer for deliberate narrowings only.
		 */
		const serve = (diff: string, provenance: ReadonlyArray<string>): VerbOutcome => {
			const preview = previewOf(diff, placement, patterns, probes);
			if (preview._tag === "Refused") {
				const detail = preview.refusals
					.map((entry) => `"${entry.pattern}" matches the ${entry.guard} probe "${entry.probe}"`)
					.join("; ");
				return refuse(
					GOVERNED_FILTER,
					`${VERB}: exclusion pattern intersects a governed root — ${detail}. A filter that blinds a governed surface is refused, not narrowed; guard corpora are protected by the consumer split (guards read the raw path list).`,
					provenance,
				);
			}
			const result = preview.result;
			if (options.emitDiff) {
				return answer(result.filtered_diff, [
					...provenance,
					`${VERB}: placement=${result.placement} matched=${result.matched_paths.length} excluded=${result.excluded.length}`,
				]);
			}
			if (options.json) {
				return answer(
					JSON.stringify({
						outcome: "previewed",
						placement: result.placement,
						matched_paths: result.matched_paths,
						excluded: {count: result.excluded.length, paths: result.excluded},
						...(result.unexcluded.length > 0
							? {unexcluded: {count: result.unexcluded.length, paths: result.unexcluded}}
							: {}),
						active_classes: result.active_classes,
						namespaces: result.namespaces,
						filtered_diff_bytes: result.filtered_diff_bytes,
						filtered_diff_lines: result.filtered_diff_lines,
					}),
					provenance,
				);
			}
			return answer(
				[
					`preview\t${result.placement}`,
					`matched\t${result.matched_paths.length}`,
					...result.active_classes.map((entry) => `class\t${entry.name}\t${entry.files}`),
					...result.namespaces.map((namespace) => `namespace\t${namespace}`),
					`excluded\t${result.excluded.length}`,
					...result.excluded.map((path) => `excluded-path\t${path}`),
					// A removed default is the one exclusion nothing on this run's command line asked for —
					// enumerated so the narrowed filter is stated, and only when it narrowed.
					...(result.unexcluded.length > 0
						? [
								`un-excluded\t${result.unexcluded.length}`,
								...result.unexcluded.map((path) => `un-excluded-path\t${path}`),
							]
						: []),
				].join("\n"),
				provenance,
			);
		};

		/**
		 * The completeness proof every subject runs before its bytes reach the filter — the same
		 * operands `review diff` proves with: `filesInDiff` against `diffRangePaths` over ONE range,
		 * both counts from git, so a short read refuses rather than serving a prefix as the whole.
		 */
		const shortRead = (
			diff: string,
			inRange: number,
			rangeSpelling: string,
			at: string,
			provenance: ReadonlyArray<string>,
		): VerbOutcome | null => {
			const seen = filesInDiff(diff);
			if (seen >= inRange) return null;
			return refuse(
				INCOMPLETE_SCAN,
				`${VERB}: the diff at ${at} carries ${seen} of the ${inRange} files git reports for the same range ${rangeSpelling} — both counts from git, so this diff is provably short; refusing to serve a partial diff as the whole.`,
				provenance,
			);
		};

		if (diffFile !== null) {
			if (sha !== null || repo !== null) {
				return refuse(
					OFF_VOCABULARY,
					`${VERB}: --sha and --repo are PR-subject modifiers — a --diff-file subject binds no head and no repository.`,
				);
			}
			const read = yield* Effect.match(
				Effect.try({
					try: () => readFileSync(diffFile, "utf8"),
					catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
				}),
				{
					onFailure: (reason: string) => ({_tag: "Refused" as const, message: reason}),
					onSuccess: (text: string) => ({_tag: "Loaded" as const, text}),
				},
			);
			if (read._tag === "Refused") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read --diff-file "${diffFile}": ${read.message}`,
				);
			}
			return serve(read.text, []);
		}

		if (pr !== null) {
			const bad = badNumber(VERB, "a pull-request number", pr);
			if (bad !== null) return bad;
			const resolved = yield* resolveTargetRepo(VERB, repo, options.env ?? {});
			if (resolved._tag === "Refused") return resolved.outcome;
			const target = yield* openPull(VERB, resolved.repo, pr, {
				requireOpen: true,
				requireFiles: true,
				emptyReason: "refusing to preview an empty diff.",
			});
			if (target._tag === "Refused") return target.outcome;
			const bound = yield* bindHead(VERB, resolved.repo, pr, target.pull, sha);
			if (bound._tag === "Refused") return bound.outcome;
			const head = bound.head;
			const served = yield* diffRange(head.mergeBase, head.sha);
			if (served._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read the diff for #${pr} at ${head.sha}: ${served.reason} — UNKNOWN.`,
				);
			}
			const listed = yield* diffRangePaths(head.mergeBase, head.sha);
			if (listed._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read the file list of the range ${head.mergeBase}...${head.sha} for #${pr}: ${listed.reason} — UNKNOWN.`,
				);
			}
			const provenance = [boundLine(VERB, head)];
			const short = shortRead(
				served.value,
				listed.value.length,
				`${head.mergeBase}...${head.sha}`,
				head.sha,
				provenance,
			);
			if (short !== null) return short;
			return serve(served.value, provenance);
		}

		if (repo !== null) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --repo is a PR-subject modifier — a range binds content in this checkout, not a named repository.`,
			);
		}
		const ranged = readRangeFlags(VERB, {base, tip, sha});
		if (ranged._tag !== "Ranged") {
			// `Pull` is unreachable — the subject count above proved a range was named — and its fold
			// here is the no-subject refusal, the only honest reading of "no range named".
			return ranged._tag === "Refused"
				? ranged.outcome
				: refuse(OFF_VOCABULARY, `${VERB}: name exactly one subject — ${SUBJECTS}.`);
		}
		const range = ranged.range;
		const merged = yield* rangeMergeBase(range);
		if (merged._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot resolve the merge base of ${range.base} and ${range.tip}: ${merged.reason} — the range's diff is UNKNOWN.`,
			);
		}
		const served = yield* diffRange(merged.value, range.tip);
		if (served._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the diff for the range ${range.base}...${range.tip}: ${served.reason} — UNKNOWN.`,
			);
		}
		const listed = yield* diffRangePaths(merged.value, range.tip);
		if (listed._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the file list of the range ${range.base}...${range.tip}: ${listed.reason} — UNKNOWN.`,
			);
		}
		const provenance = [
			`${VERB}: range ${range.base}...${range.tip} at merge base ${merged.value} — read from the object database, nothing checked out.`,
		];
		const short = shortRead(
			served.value,
			listed.value.length,
			`${range.base}...${range.tip}`,
			range.tip,
			provenance,
		);
		if (short !== null) return short;
		return serve(served.value, provenance);
	});
