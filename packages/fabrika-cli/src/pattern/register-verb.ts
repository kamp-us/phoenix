/**
 * `pattern register` — the doc's row inserted into `<dir>/index.md` under a named section.
 *
 * It reads the index **from the working tree**, not from a base ref: this verb edits the tree, so it
 * must read what it is about to write. That is the deliberate half of the group's two-reads split —
 * `corpus`, `drift` and `anchor` answer what the repository already holds, `new` and `register`
 * write what it is about to.
 */
import {Effect, type FileSystem, type Path, Result} from "effect";
import {exists, readFile, writeFile} from "../io/fs.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {
	DOC_ABSENT,
	INDEX_UNPARSEABLE,
	MULTI_LINE_DIFF,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	SECTION_AMBIGUOUS,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {isKebabCase} from "./doc.ts";
import {insertRow, readBackCarries} from "./register.ts";

export interface RegisterOptions {
	readonly slug: string;
	readonly section: string;
	readonly topic: string;
	readonly readWhen: string;
	readonly dir: string;
	readonly json: boolean;
}

export const runRegister = (
	options: RegisterOptions,
): Effect.Effect<VerbOutcome, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const {slug, section, dir, json} = options;
		if (!isKebabCase(slug)) {
			return refuse(
				FAILED,
				`pattern register: slug "${slug}" is not kebab-case (lowercase letters, digits and single hyphens).`,
			);
		}

		const root = dir.replace(/\/+$/, "");
		const indexPath = `${root}/index.md`;
		const docPath = `${root}/${slug}.md`;
		// The two refusals name the doc as written and unregistered on purpose: `new` and `register`
		// are separable precisely so a doc can land in a repo whose index is missing.
		const unparseable = (why: string) =>
			refuse(
				INDEX_UNPARSEABLE,
				`pattern register: ${indexPath} ${why} — the doc at ${docPath} is written and unregistered; front-door bootstraps the index.`,
			);

		const indexThere = yield* Effect.result(exists(indexPath));
		if (Result.isFailure(indexThere)) {
			return refuse(
				PRECONDITION_UNKNOWN,
				`pattern register: cannot check ${indexPath}: ${indexThere.failure.reason} — nothing was written.`,
			);
		}
		if (!indexThere.success) return unparseable("is absent");

		const indexText = yield* Effect.result(readFile(indexPath));
		if (Result.isFailure(indexText)) {
			return refuse(
				PRECONDITION_UNKNOWN,
				`pattern register: cannot read ${indexPath}: ${indexText.failure.reason} — nothing was written.`,
			);
		}

		const docThere = yield* Effect.result(exists(docPath));
		if (Result.isFailure(docThere)) {
			return refuse(
				PRECONDITION_UNKNOWN,
				`pattern register: cannot check ${docPath}: ${docThere.failure.reason} — nothing was written.`,
			);
		}
		if (!docThere.success) {
			return refuse(
				DOC_ABSENT,
				`pattern register: no doc at ${docPath} — refusing to register a row pointing at nothing.`,
			);
		}

		const outcome = insertRow(indexText.success, {
			slug,
			section,
			topic: options.topic,
			readWhen: options.readWhen,
		});

		if (outcome._tag === "NoTable") return unparseable("holds no parseable markdown table");
		if (outcome._tag === "NoSection") {
			// Never truncated: a caller correcting a flag needs the whole set, so the next invocation is
			// a correction rather than a guess.
			return refuse(
				OFF_VOCABULARY,
				`pattern register: no section "${section}" in ${indexPath} (present: ${outcome.present.join(", ")}).`,
			);
		}
		if (outcome._tag === "Ambiguous") {
			return refuse(
				SECTION_AMBIGUOUS,
				`pattern register: "${section}" matches ${outcome.count} headings in ${indexPath} — ambiguous, nothing written.`,
			);
		}
		if (outcome._tag === "MultiLine") {
			return refuse(
				MULTI_LINE_DIFF,
				`pattern register: insertion would have changed ${outcome.beyond} line(s) beyond the new row — aborted, nothing written.`,
			);
		}
		if (outcome._tag === "Already") {
			return answer(
				json
					? JSON.stringify({
							outcome: "already",
							path: indexPath,
							slug,
							section: outcome.section,
							row: null,
						})
					: ["already", indexPath, outcome.section].join("\t"),
				[`pattern register: ${indexPath} already links ${slug}.md — registering twice is a no-op.`],
			);
		}

		const written = yield* Effect.result(writeFile(indexPath, outcome.text));
		if (Result.isFailure(written)) {
			return refuse(
				WRITE_UNKNOWN,
				`pattern register: cannot write ${indexPath}: ${written.failure.reason} — whether anything landed is UNKNOWN.`,
			);
		}

		const back = yield* Effect.result(readFile(indexPath));
		if (Result.isFailure(back) || !readBackCarries(back.success, slug, outcome.section)) {
			return refuse(
				READBACK_MISMATCH,
				`pattern register: ${indexPath} was written and the read-back does not carry the row — the file needs a human.`,
			);
		}

		return answer(
			json
				? JSON.stringify({
						outcome: "inserted",
						path: indexPath,
						slug,
						section: outcome.section,
						row: outcome.row,
					})
				: ["inserted", indexPath, outcome.section].join("\t"),
			[
				`pattern register: inserted one row under "${outcome.section}" in ${indexPath}, proven to change no other line.`,
			],
		);
	});
