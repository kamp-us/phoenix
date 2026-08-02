/**
 * `adr supersede` and `adr amend-in-part` — one mechanic, two relationships.
 *
 * Both rewrite the frontmatter `status:` line of the older record and nothing else. The written
 * value resolves `--by`'s slug **off disk**, and refuses when `--by` has no record, because a
 * guessed slug is the recurring dead-link failure (#1777).
 */
import type {FileSystemLike} from "../io/fs.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {idFromFile, partitionRecordNames} from "./records.ts";
import {type Relationship, rewriteStatus} from "./status-line.ts";

/** `<id>` has no record under `--dir`. */
export const NO_SUBJECT = 3;
/** `--by` has no record under `--dir` — the link would be dead on arrival. */
export const NO_BY = 4;
/** `<id>`'s frontmatter has no single rewritable `status:` line. */
export const NO_STATUS_LINE = 5;
/** The rewrite would have changed a line other than `status:` — aborted before writing. */
export const MULTI_LINE_DIFF = 6;
/** `<id>` is already `superseded by …`, so it is not amendable or re-supersedable. */
export const ALREADY_SUPERSEDED = 7;

export interface RelateOptions {
	readonly relationship: Relationship;
	readonly id: string;
	readonly by: string;
	readonly dir: string;
	readonly json: boolean;
}

const verbName = (relationship: Relationship): string =>
	relationship === "supersede" ? "adr supersede" : "adr amend-in-part";

/** The record filename for `id` under `dir`, or `null` when no record claims it. */
const fileForId = (fs: FileSystemLike, dir: string, id: string): string | null => {
	const names = fs.readDir(dir);
	if (names === null) return null;
	return partitionRecordNames(names).records.find((f) => idFromFile(f) === id) ?? null;
};

export const runRelate = (fs: FileSystemLike, options: RelateOptions): VerbOutcome => {
	const {relationship, id, by, dir, json} = options;
	const verb = verbName(relationship);
	const root = dir.replace(/\/+$/, "");

	const subjectFile = fileForId(fs, root, id);
	if (subjectFile === null)
		return refuse(NO_SUBJECT, `${verb}: no record for id ${id} under ${root}.`);

	const byFile = fileForId(fs, root, by);
	if (byFile === null) {
		return refuse(
			NO_BY,
			`${verb}: no record for --by id ${by} under ${root} — refusing to write a dead link.`,
		);
	}

	const path = `${root}/${subjectFile}`;
	const before = fs.readFile(path);
	if (before === null) return refuse(FAILED, `${verb}: cannot read ${path}.`);

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
	if (outcome.text !== before && !fs.writeFile(path, outcome.text)) {
		return refuse(FAILED, `${verb}: cannot write ${path}: the write failed`);
	}

	return answer(
		json
			? JSON.stringify({path, id, by, statusBefore, statusAfter: outcome.statusAfter})
			: `${path}\t${outcome.statusAfter}`,
	);
};
