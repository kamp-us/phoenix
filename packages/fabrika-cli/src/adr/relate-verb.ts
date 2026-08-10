/**
 * `adr supersede` and `adr amend-in-part` — one mechanic, two relationships.
 *
 * Both rewrite the frontmatter `status:` line of the older record and nothing else. The written
 * value resolves `--by`'s slug **off disk**, and refuses when `--by` has no record, because a
 * guessed slug is the recurring dead-link failure (#1777).
 */
import {Effect, type FileSystem, type Path, Result} from "effect";
import {readDir, readFile, writeFile} from "../io/fs.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {ALREADY_SUPERSEDED, MULTI_LINE_DIFF, NO_BY, NO_STATUS_LINE, NO_SUBJECT} from "./codes.ts";
import {idFromFile, partitionRecordNames} from "./records.ts";
import {type Relationship, rewriteStatus} from "./status-line.ts";

export interface RelateOptions {
	readonly relationship: Relationship;
	readonly id: string;
	readonly by: string;
	readonly dir: string;
	readonly json: boolean;
}

const verbName = (relationship: Relationship): string =>
	relationship === "supersede" ? "adr supersede" : "adr amend-in-part";

/** The record filenames under `dir`, or `null` when the directory could not be listed. */
const recordNames = (
	dir: string,
): Effect.Effect<ReadonlyArray<string> | null, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const names = yield* Effect.result(readDir(dir));
		return Result.isFailure(names) ? null : partitionRecordNames(names.success).records;
	});

export const runRelate = (
	options: RelateOptions,
): Effect.Effect<VerbOutcome, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const {relationship, id, by, dir, json} = options;
		const verb = verbName(relationship);
		const root = dir.replace(/\/+$/, "");

		const names = yield* recordNames(root);
		const fileForId = (wanted: string): string | null =>
			names?.find((f) => idFromFile(f) === wanted) ?? null;

		const subjectFile = fileForId(id);
		if (subjectFile === null)
			return refuse(NO_SUBJECT, `${verb}: no record for id ${id} under ${root}.`);

		const byFile = fileForId(by);
		if (byFile === null) {
			return refuse(
				NO_BY,
				`${verb}: no record for --by id ${by} under ${root} — refusing to write a dead link.`,
			);
		}

		const path = `${root}/${subjectFile}`;
		const read = yield* Effect.result(readFile(path));
		if (Result.isFailure(read))
			return refuse(FAILED, `${verb}: cannot read ${path}: ${read.failure.reason}`);
		const before = read.success;

		const outcome = rewriteStatus(relationship, before, {id: by, file: byFile});
		if (outcome._tag === "NoSingleStatusLine") {
			return refuse(
				NO_STATUS_LINE,
				`${verb}: ${path} has no single frontmatter status: line to rewrite.`,
			);
		}
		if (outcome._tag === "AlreadySuperseded") {
			return refuse(
				ALREADY_SUPERSEDED,
				relationship === "amend-in-part"
					? `${verb}: ${path} is already "superseded by …" — a superseded ADR is not amendable.`
					: `${verb}: ${path} is already "superseded by …" — a superseded ADR is not re-supersedable.`,
			);
		}
		if (outcome._tag === "MultiLineDiff") {
			return refuse(
				MULTI_LINE_DIFF,
				`${verb}: rewrite would have changed ${outcome.changed} line(s) beyond status: — aborted, nothing written.`,
			);
		}

		const statusBefore = /^status:\s?(.*)$/m.exec(before)?.[1] ?? "";
		if (outcome.text !== before) {
			const written = yield* Effect.result(writeFile(path, outcome.text));
			if (Result.isFailure(written)) {
				return refuse(FAILED, `${verb}: cannot write ${path}: ${written.failure.reason}`);
			}
		}

		return answer(
			json
				? JSON.stringify({path, id, by, statusBefore, statusAfter: outcome.statusAfter})
				: `${path}\t${outcome.statusAfter}`,
		);
	});
