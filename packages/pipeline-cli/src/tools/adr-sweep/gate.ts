/**
 * The `adr-sweep` filesystem seam — split from `command.ts` so it is crossable over a fake
 * `.decisions` dir in unit tests rather than only by spawning the bin (the core-in-its-own-file
 * idiom; #855). The verdict itself is the pure core (`adr-sweep.ts`).
 *
 * **Exit contract.** Exit 0 iff the sweep ran and produced `no-overlap`. A `shortlist` and an
 * `indeterminate` both exit non-zero — the tool cannot clear a shortlist entry (only the
 * author/reviewer can) and it must never let "I could not sweep" read as "nothing found". A
 * missing subject ADR, malformed front-matter anywhere in the corpus, and zero live-accepted
 * ADRs in scope all fail closed (ADR 0092); an unreadable corpus is an `IoError`, also non-zero.
 * Exit 0 is therefore evidence that nothing mechanically adjacent was left to open — never a
 * certificate that no contradiction exists (see `CAVEAT`).
 */
import {Console, Effect, FileSystem, Path} from "effect";
import * as Schema from "effect/Schema";
import {numberFromFile} from "../decisions-index/decisions-index.ts";
import {readAdrFiles} from "../decisions-index/gate.ts";
import {
	type AdrDoc,
	CAVEAT,
	renderReport,
	type SweepResult,
	SweepScopeError,
	sweep,
} from "./adr-sweep.ts";

/** A directory/file IO failure: the run couldn't complete. */
export class IoError extends Schema.TaggedErrorClass<IoError>()("IoError", {
	path: Schema.String,
	cause: Schema.Unknown,
}) {}

/** Carries the non-zero exit (the report is already on stderr). */
export class CheckFailed extends Schema.TaggedErrorClass<CheckFailed>()("CheckFailed", {
	reason: Schema.String,
}) {}

const ADR_ID = /^\d{4}[A-Za-z]?$/;

/**
 * Resolve `--new`: a bare `NNNN` names an ADR already sitting in the corpus dir; anything else
 * is a path to the ADR file (the shape an author or a reviewer has mid-PR, before the file is on
 * the base ref). An id with no matching file fails closed rather than sweeping nothing.
 */
export const resolveSubject = (
	newRef: string,
	dir: string,
	corpus: ReadonlyArray<AdrDoc>,
): Effect.Effect<AdrDoc, IoError | CheckFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		if (ADR_ID.test(newRef)) {
			const hit = corpus.find((d) => numberFromFile(d.file) === newRef);
			if (hit === undefined) {
				return yield* Effect.fail(
					new CheckFailed({
						reason: `no ADR file for id \`${newRef}\` in ${dir} — pass the file path instead when the ADR is not on this ref.`,
					}),
				);
			}
			return hit;
		}
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const text = yield* fs
			.readFileString(newRef, "utf8")
			.pipe(Effect.mapError((cause) => new IoError({path: newRef, cause})));
		return {file: path.basename(newRef), text};
	});

export interface SweepOptions {
	readonly dir: string;
	readonly newRef: string;
	readonly limit: number;
	readonly json: boolean;
}

/**
 * Read the corpus, sweep the subject against it, emit the report, and carry the exit contract.
 * `SweepScopeError` (malformed front-matter, zero scope) folds into `CheckFailed` — the sweep
 * never reports a clean run over a corpus it could not read.
 */
export const runSweep = ({
	dir,
	newRef,
	limit,
	json,
}: SweepOptions): Effect.Effect<void, IoError | CheckFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const corpus = yield* readAdrFiles(dir).pipe(
			Effect.mapError((e) => new IoError({path: dir, cause: e})),
		);
		const subject = yield* resolveSubject(newRef, dir, corpus);
		const result: SweepResult = yield* Effect.try({
			try: () => sweep({newAdr: subject, corpus, limit}),
			catch: (cause) =>
				new CheckFailed({
					reason:
						cause instanceof SweepScopeError
							? `adr-sweep: ${cause.detail}`
							: `adr-sweep: ${String((cause as Error)?.message ?? cause)}`,
				}),
		});
		const report = json
			? JSON.stringify({...result, caveat: CAVEAT}, null, 2)
			: renderReport(result);
		if (result.outcome._tag === "no-overlap") {
			yield* Console.log(report);
			return;
		}
		return yield* Effect.fail(new CheckFailed({reason: report}));
	});
