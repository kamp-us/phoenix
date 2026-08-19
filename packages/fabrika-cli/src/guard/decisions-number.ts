/**
 * `guard decisions-index validate` core — the ADR number lock (ADR 0074): every `.decisions/` record
 * declares the four index fields, its filename number and its frontmatter `id` name the same ADR,
 * and no two records claim one id.
 *
 * The two invariants are one guard because they compose. The id-keyed duplicate check is what
 * catches the #1471 collision class — two branches each minting 0284, green apart, colliding once
 * both land — and it only sees a filename collision because the prefix↔`id` lock forces the two
 * axes to agree. Drop either half and a collision hides behind the other axis.
 *
 * IO-free: pure over the files' names and texts. The directory read lives in
 * `./decisions-number-verb.ts`, and the frontmatter/id parsing is fabrika's own
 * `../adr/records.ts` — this guard adds the rules, not a second parser.
 */

import {idFromFile, idSortKey, parseFrontmatter} from "../adr/records.ts";

/** A record filename plus its full text. */
export interface DecisionFile {
	readonly file: string;
	readonly text: string;
}

/** The frontmatter fields an index row is rendered from — all four are required. */
const REQUIRED_FIELDS = ["id", "title", "status", "date"] as const;

/** One record's break of the lock. Each names the file, so a report needs nothing else. */
export type NumberDefect =
	/** A required frontmatter field is absent or empty. */
	| {readonly _tag: "MissingField"; readonly file: string; readonly field: string}
	/** The filename number and the frontmatter `id` name different ADRs. */
	| {
			readonly _tag: "NumberMismatch";
			readonly file: string;
			readonly filePrefix: string;
			readonly id: string;
	  }
	/** Two or more records claim one id. */
	| {readonly _tag: "DuplicateId"; readonly id: string; readonly files: ReadonlyArray<string>};

/**
 * Every defect across the records, in report order: per-file defects first (by filename), then the
 * duplicates (by id).
 *
 * A file with a missing or mismatched `id` contributes NO id to the duplicate scan — counting one
 * would let a malformed record manufacture a phantom collision on top of its own real defect.
 */
export const findDefects = (files: ReadonlyArray<DecisionFile>): ReadonlyArray<NumberDefect> => {
	const perFile: Array<NumberDefect> = [];
	const byId = new Map<string, Array<string>>();
	for (const {file, text} of [...files].sort((a, b) => a.file.localeCompare(b.file))) {
		const fm = parseFrontmatter(text);
		const missing = REQUIRED_FIELDS.filter((field) => (fm[field] ?? "") === "");
		for (const field of missing) perFile.push({_tag: "MissingField", file, field});
		const id = fm.id ?? "";
		if (id === "") continue;
		const filePrefix = idFromFile(file);
		if (filePrefix !== null && filePrefix !== id) {
			perFile.push({_tag: "NumberMismatch", file, filePrefix, id});
			continue;
		}
		if (missing.length > 0) continue;
		byId.set(id, [...(byId.get(id) ?? []), file]);
	}
	const duplicates: Array<NumberDefect> = [...byId.entries()]
		.filter(([, dupes]) => dupes.length > 1)
		.sort(([a], [b]) => {
			const [an] = idSortKey(a);
			const [bn] = idSortKey(b);
			return an - bn;
		})
		.map(([id, dupeFiles]) => ({_tag: "DuplicateId", id, files: dupeFiles}) as const);
	return [...perFile, ...duplicates];
};

/** One defect as a report line. */
export const describeDefect = (defect: NumberDefect): string => {
	switch (defect._tag) {
		case "MissingField":
			return `  ${defect.file}: missing frontmatter field \`${defect.field}\``;
		case "NumberMismatch":
			return `  ${defect.file}: filename number \`${defect.filePrefix}\` does not match frontmatter \`id: ${defect.id}\``;
		case "DuplicateId":
			return `  duplicate ADR id ${defect.id} in: ${defect.files.join(", ")}`;
	}
};

/** The file a defect should be annotated on — a duplicate is annotated on every colliding record. */
export const defectFiles = (defect: NumberDefect): ReadonlyArray<string> =>
	defect._tag === "DuplicateId" ? defect.files : [defect.file];
