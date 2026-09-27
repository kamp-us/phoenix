/**
 * `review diff` — the PR's diff bytes, read out of one commit, with a short read refused rather than
 * silently passed through.
 *
 * This verb is not a relay, and two proofs are why. **Completeness:** a diff carrying fewer files
 * than git lists for the same range is refused, because a gate that judged the visible prefix as the
 * whole PR is the blind-PASS class one layer down; v1's `pr-diff.sh` was the relay, and
 * nothing checked what it served. This is not a guard against a truncating platform: the diff media type refuses an
 * over-limit diff rather than serving a short one, and these bytes never come from it — see
 * `diff.ts` for what the proof does and does not cover. **Provenance:** the bytes come from
 * the object database at the bound commit via `diffRange`, never from an endpoint that takes a PR
 * number and no commit — see `head.ts` for why a SHA on the verdict is not the same thing as bytes
 * from that SHA.
 */
import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {
	governedRootsOr,
	reviewFilterExclusionsOr,
	reviewFilterUnexcludeOr,
} from "../config/paths.ts";
import {diffRange, diffRangePaths} from "../io/git.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {GOVERNED_FILTER, INCOMPLETE_SCAN, PRECONDITION_UNKNOWN} from "./codes.ts";
import {filesInDiff} from "./diff.ts";
import {
	applyPlacement,
	effectiveExclusions,
	type FilterPlacement,
	filterDiff,
	governedExcluded,
	refusalFor,
} from "./filter-spike.ts";
import {refusalProbes} from "./guard-trees.ts";
import {bindHead, boundLine} from "./head.ts";
import {badNumber, openPull, resolveTargetRepo, scannedLine} from "./target.ts";

const VERB = "review diff";

export interface DiffOptions {
	readonly pr: number;
	/** The head the caller scoped. `null` binds to the PR's live head instead of asserting one. */
	readonly sha: string | null;
	readonly repo: string | null;
	/** `after` serves the filtered diff with its exclusion header; null = off. */
	readonly filterPlacement?: FilterPlacement | null;
	/** comma-separated extra exclusion patterns, refused on a guard-probe match. */
	readonly exclude?: string | null;
	/** Explicit roots for callers with a proven config read; otherwise read only when filtering. */
	readonly governedRoots?: ReadonlyArray<string>;
	/**
	 * Where the exclusion set's own config arms are read, when the placement turns the filter on —
	 * the checkout the caller stands in; omitted cwd falls to the process's;
	 * an absent or keyless `.fabrika.jsonc` there resolves the shipped empty arms and changes no
	 * byte of the served diff.
	 */
	readonly cwd?: string;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export const runDiff = (
	options: DiffOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const {pr} = options;
		const bad = badNumber(VERB, "a pull-request number", pr);
		if (bad !== null) return bad;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const target = yield* openPull(VERB, repo, pr, {
			requireOpen: true,
			requireFiles: true,
			emptyReason: "refusing to serve an empty diff as a reviewable one.",
		});
		if (target._tag === "Refused") return target.outcome;
		const pull = target.pull;

		const bound = yield* bindHead(VERB, repo, pr, pull, options.sha);
		if (bound._tag === "Refused") return bound.outcome;
		const head = bound.head;

		const served = yield* diffRange(head.mergeBase, head.sha);
		if (served._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the diff for #${pr} at ${head.sha}: ${served.reason} — UNKNOWN.`,
			);
		}
		const diff = served.value;

		// Both operands of the refusal below come from git over the SAME range under the SAME flags —
		// `--name-only -z` emits exactly one path per `diff --git` entry, renames paired identically —
		// so rename pairing and merge-base choice cancel instead of being compared across systems. What
		// that does and does not prove is in `diff.ts`. GitHub's `changed_files` is its own merge base
		// and its own rename detection, so it is reported below and never refused on.
		const listed = yield* diffRangePaths(head.mergeBase, head.sha);
		if (listed._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the file list of the range ${head.mergeBase}...${head.sha} for #${pr}: ${listed.reason} — UNKNOWN.`,
			);
		}
		const inRange = listed.value.length;

		const seen = filesInDiff(diff);
		const diagnostics = [
			boundLine(VERB, head),
			scannedLine(
				VERB,
				seen,
				"file",
				`${inRange} in the range per git, ${pull.changedFiles} declared by GitHub, ${new TextEncoder().encode(diff).length} bytes`,
			),
		];
		if (inRange !== pull.changedFiles) {
			diagnostics.push(
				`${VERB}: git and GitHub disagree on #${pr}'s file count (${inRange} vs ${pull.changedFiles}) — different merge base and different rename detection; reported, never refused on.`,
			);
		}
		if (seen < inRange) {
			return refuse(
				INCOMPLETE_SCAN,
				`${VERB}: the diff at ${head.sha} carries ${seen} of the ${inRange} files git reports for the same range ${head.mergeBase}...${head.sha} — both counts from git, so this diff is provably short; refusing to serve a partial diff as the whole.`,
				diagnostics,
			);
		}
		// the filter runs strictly AFTER the completeness proof above, so a deliberate
		// exclusion can never masquerade as a short read — the header names what was left out on
		// purpose. Refusal union derived per run over the EFFECTIVE set — defaults minus the config's
		// removals, plus its additions, plus `--exclude` — against the guards' probes plus the
		// governed roots. A removed default nothing re-added is named in the served
		// diff's header and in the diagnostic beside it, so a narrowed filter is never silent.
		let servedDiff = diff;
		if (options.filterPlacement != null) {
			const root = options.cwd ?? process.cwd();
			let roots = options.governedRoots;
			if (roots === undefined) {
				const loaded = yield* governedRootsOr(
					VERB,
					root,
					"the filter refusal union is UNKNOWN without the governed roots.",
				);
				if (loaded._tag === "Refused") return refuse(PRECONDITION_UNKNOWN, loaded.message);
				roots = loaded.roots;
			}

			const filterExclusions = yield* reviewFilterExclusionsOr(
				VERB,
				root,
				"which globs extend the exclusion set is UNKNOWN and the served diff would carry a set nobody derived.",
			);
			if (filterExclusions._tag === "Refused") {
				return refuse(PRECONDITION_UNKNOWN, filterExclusions.message);
			}
			const filterUnexclude = yield* reviewFilterUnexcludeOr(
				VERB,
				root,
				"which defaults the exclusion set drops is UNKNOWN and the served diff would carry a set nobody derived.",
			);
			if (filterUnexclude._tag === "Refused") {
				return refuse(PRECONDITION_UNKNOWN, filterUnexclude.message);
			}
			const effective = effectiveExclusions(
				filterExclusions.exclusions,
				filterUnexclude.unexclude,
				options.exclude ?? null,
			);
			const refused = refusalFor(effective.patterns, refusalProbes(roots));
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
			const split = applyPlacement(listed.value, effective.patterns);
			const governed = governedExcluded(split.excluded, effective.patterns, refusalProbes(roots));
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
			servedDiff = filterDiff(diff, split.excluded, options.filterPlacement, effective.unexcluded);
			diagnostics.push(
				`${VERB}: filter placement=${options.filterPlacement} excluded=${split.excluded.length} served=${listed.value.length - split.excluded.length}${effective.unexcluded.length > 0 ? ` unexcluded=${effective.unexcluded.length}` : ""} of ${listed.value.length} files — deliberate, not truncated.`,
			);
		}
		return answer(servedDiff, diagnostics);
	});
