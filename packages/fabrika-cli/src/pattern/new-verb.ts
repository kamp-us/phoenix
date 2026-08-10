/**
 * `pattern new` — scaffold one doc from the canonical template.
 *
 * Not a judging verb: it writes exactly one file and never edits another. The index row is
 * `pattern register`'s, and separating them is what lets a doc land in a repo whose index is
 * missing. Creating `--dir` when it is absent is the bootstrap half of the same rule — a repo
 * adopting fabrika has no `.patterns/`, and its first doc has to be writable on the documented path.
 */
import {Effect, type FileSystem, type Path, Result} from "effect";
import {exists, writeFile} from "../io/fs.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {ALREADY_EXISTS, PRECONDITION_UNKNOWN, WRITE_UNKNOWN} from "./codes.ts";
import {docTemplate, isKebabCase, splitAnchorToken, titleFrom} from "./doc.ts";

export interface NewOptions {
	readonly slug: string;
	readonly dir: string;
	readonly title: string | null;
	readonly anchor: string | null;
	readonly json: boolean;
}

export const runNew = (
	options: NewOptions,
): Effect.Effect<VerbOutcome, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const {slug, dir, anchor, json} = options;
		if (!isKebabCase(slug)) {
			return refuse(
				FAILED,
				`pattern new: slug "${slug}" is not kebab-case (lowercase letters, digits and single hyphens).`,
			);
		}
		// Validated by `pattern anchor`'s own split rule, so the writer and the reader of the anchor
		// line accept exactly the same strings.
		if (anchor !== null && splitAnchorToken(anchor) === null) {
			return refuse(FAILED, `pattern new: --anchor "${anchor}" is not <pkg>@<version>.`);
		}

		const path = `${dir.replace(/\/+$/, "")}/${slug}.md`;
		const present = yield* Effect.result(exists(path));
		// A probe that could not RUN is not "absent": answering absent here would license a write over
		// a doc this verb never managed to look at.
		if (Result.isFailure(present)) {
			return refuse(
				PRECONDITION_UNKNOWN,
				`pattern new: cannot check ${path}: ${present.failure.reason} — nothing was written.`,
			);
		}
		if (present.success) {
			return refuse(ALREADY_EXISTS, `pattern new: ${path} already exists — refusing to overwrite.`);
		}

		const title = options.title ?? titleFrom(slug);
		const written = yield* Effect.result(writeFile(path, docTemplate(title, anchor)));
		if (Result.isFailure(written)) {
			return refuse(
				WRITE_UNKNOWN,
				`pattern new: cannot write ${path}: ${written.failure.reason} — whether anything landed is UNKNOWN.`,
			);
		}

		return answer(json ? JSON.stringify({path, slug, title, anchored: anchor}) : path, [
			`pattern new: wrote ${path}${anchor === null ? "" : ` with the anchor line for ${anchor}`}; the index row is pattern register's.`,
		]);
	});
