/**
 * `review preview` — the read-only path extraction behind review diff filtering: matched paths,
 * exclusions, and the active class partition at the requested filter placement, with the filtered
 * diff available on the same answer. No LLM, no network, no write: the diff arrives from
 * `--diff-file` on disk.
 *
 * Refusal mapping: a placement off the two-value vocabulary seats on `OFF_VOCABULARY`; an
 * exclusion pattern matching a governed root seats on `GOVERNED_FILTER` (the hard invariant); an
 * unreadable diff file is `PRECONDITION_UNKNOWN` — never a permissive empty read.
 */
import {readFileSync} from "node:fs";
import {Effect, type FileSystem, type Path} from "effect";
import {governedRootsOr} from "../config/paths.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {GOVERNED_FILTER, OFF_VOCABULARY, PRECONDITION_UNKNOWN} from "./codes.ts";
import {
	DEFAULT_EXCLUSIONS,
	type ExclusionPattern,
	isFilterPlacement,
	parseExcludeList,
	previewOf,
} from "./filter-spike.ts";
import {refusalProbes} from "./guard-trees.ts";

const VERB = "review preview";

export interface PreviewOptions {
	readonly diffFile: string;
	/** `null` (flag omitted) is refused — the verb exists to compare the two placements. */
	readonly filterPlacement: string | null;
	/** Comma-separated extra patterns; blanks dropped. Refused when one matches a guard probe. */
	readonly exclude: string | null;
	readonly emitDiff: boolean;
	readonly json: boolean;
	/** Where to look for `.fabrika.jsonc` — the governed roots half of the refusal union. */
	readonly cwd: string;
}

export const runPreview = (
	options: PreviewOptions,
): Effect.Effect<VerbOutcome, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		if (options.filterPlacement === null) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --filter-placement is required — the verb compares \`before\` and \`after\` only`,
			);
		}
		if (!isFilterPlacement(options.filterPlacement)) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --filter-placement must be \`before\` or \`after\`, got "${options.filterPlacement}"`,
			);
		}
		if (options.emitDiff && options.json) {
			return refuse(OFF_VOCABULARY, `${VERB}: --emit-diff and --json are mutually exclusive`);
		}
		const roots = yield* governedRootsOr(
			VERB,
			options.cwd,
			"the refusal union is UNKNOWN without the governed roots, and an UNKNOWN union refuses nothing.",
		);
		if (roots._tag === "Refused") return refuse(PRECONDITION_UNKNOWN, roots.message);

		const read = yield* Effect.match(
			Effect.try({
				try: () => readFileSync(options.diffFile, "utf8"),
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
				`${VERB}: cannot read --diff-file "${options.diffFile}": ${read.message}`,
			);
		}
		const diff = read.text;

		const patterns: ReadonlyArray<ExclusionPattern> = [
			...DEFAULT_EXCLUSIONS,
			...(options.exclude == null ? [] : parseExcludeList(options.exclude)),
		];
		const preview = previewOf(diff, options.filterPlacement, patterns, refusalProbes(roots.roots));
		if (preview._tag === "Refused") {
			const detail = preview.refusals
				.map((entry) => `"${entry.pattern}" matches the ${entry.guard} probe "${entry.probe}"`)
				.join("; ");
			return refuse(
				GOVERNED_FILTER,
				`${VERB}: exclusion pattern intersects a governed root — ${detail}. A filter that blinds a governed surface is refused, not narrowed; guard corpora are protected by the consumer split (guards read the raw path list).`,
			);
		}
		const result = preview.result;
		if (options.emitDiff) {
			return answer(result.filtered_diff, [
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
					active_classes: result.active_classes,
					namespaces: result.namespaces,
					filtered_diff_bytes: result.filtered_diff_bytes,
					filtered_diff_lines: result.filtered_diff_lines,
				}),
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
			].join("\n"),
		);
	});
