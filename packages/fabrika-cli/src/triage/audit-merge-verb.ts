/**
 * `triage audit-merge` — fold a read-only audit's chunk results onto the audited set, or refuse.
 *
 * Its only dependency is the filesystem: it reads the input set and the chunk files and has no
 * handle on the issue tracker at all, so a merge cannot write one.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9834
 */
import {Effect, type FileSystem} from "effect";
import {readFile} from "../io/fs.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {
	type Chunk,
	mergeChunks,
	type Parsed,
	parseAuditSet,
	parseChunk,
	rowLine,
	verdictCounts,
} from "./audit.ts";
import {
	CHUNK_MISCOUNTED,
	DUPLICATE_VERDICT,
	MALFORMED_AUDIT,
	PRECONDITION_UNKNOWN,
	SET_MISMATCH,
	ZERO_SCOPE,
} from "./codes.ts";

const VERB = "triage audit-merge";

export interface AuditMergeOptions {
	/** The audited set, as `triage audit-set --json` printed it. */
	readonly input: string;
	/** One file per chunk. */
	readonly chunks: ReadonlyArray<string>;
	readonly json: boolean;
}

const readJson = (
	path: string,
	what: string,
): Effect.Effect<unknown, VerbOutcome, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const text = yield* readFile(path).pipe(
			Effect.mapError((failure) =>
				refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read ${what} ${path}: ${failure.reason} — the merge is UNKNOWN.`,
				),
			),
		);
		return yield* Effect.try({
			try: () => JSON.parse(text) as unknown,
			catch: (cause) =>
				refuse(MALFORMED_AUDIT, `${VERB}: ${what} ${path} is not valid JSON: ${String(cause)}.`),
		});
	});

const orRefuse = <A>(result: Parsed<A>): Effect.Effect<A, VerbOutcome> =>
	result._tag === "Parsed"
		? Effect.succeed(result.value)
		: Effect.fail(refuse(MALFORMED_AUDIT, `${VERB}: ${result.reason}.`));

const list = (issues: ReadonlyArray<number>): string =>
	issues.length === 0 ? "none" : issues.map((issue) => `#${issue}`).join(", ");

export const runAuditMerge = (
	options: AuditMergeOptions,
): Effect.Effect<VerbOutcome, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		if (options.chunks.length === 0) {
			return refuse(FAILED, `${VERB}: name at least one --chunk.`);
		}
		const input = yield* orRefuse(parseAuditSet(yield* readJson(options.input, "input set")));
		if (input.length === 0) {
			return refuse(
				ZERO_SCOPE,
				`${VERB}: the input set ${options.input} lists no issues — refusing to merge over zero scope.`,
			);
		}
		const chunks: Chunk[] = [];
		for (const path of options.chunks) {
			chunks.push(yield* orRefuse(parseChunk(path, yield* readJson(path, "chunk"))));
		}

		const merged = mergeChunks(
			input.map((issue) => issue.number),
			chunks,
		);
		switch (merged._tag) {
			case "CountMismatch":
				return refuse(
					CHUNK_MISCOUNTED,
					`${VERB}: ${merged.chunks.length} chunk(s) hold a different number of rows than they declare — re-collect them; a missing row is never rebuilt by hand.`,
					merged.chunks.map(
						(chunk) =>
							`${VERB}: ${chunk.name} declares ${chunk.declared} rows and carries ${chunk.actual}.`,
					),
				);
			case "Duplicate":
				return refuse(
					DUPLICATE_VERDICT,
					`${VERB}: ${merged.issues.length} issue(s) carry more than one verdict row — each issue gets exactly one.`,
					merged.issues.map(
						(duplicate) =>
							`${VERB}: #${duplicate.issue} is judged in ${duplicate.chunks.join(", ")}.`,
					),
				);
			case "SetMismatch":
				return refuse(
					SET_MISMATCH,
					`${VERB}: the merged rows are not the audited set — missing ${list(merged.missing)}; not in the input set ${list(merged.invented)}.`,
				);
			case "Merged": {
				const counts = verdictCounts(merged.rows);
				const summary = `${VERB}: merged ${merged.rows.length} rows from ${chunks.length} chunk(s) over ${input.length} audited issues — ${counts.KILL} KILL, ${counts.DECIDE} DECIDE, ${counts.KEEP} KEEP.`;
				return options.json
					? answer(JSON.stringify({outcome: "merged", rows: merged.rows, counts}), [summary])
					: answer(["merged", ...merged.rows.map(rowLine)].join("\n"), [summary]);
			}
		}
	}).pipe(Effect.catch(Effect.succeed));
