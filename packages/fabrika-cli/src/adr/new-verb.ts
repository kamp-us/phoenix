/**
 * `adr new` — scaffold one record from the canonical template.
 *
 * Not a judging verb: it writes exactly one file, never edits another, and never checks whether the
 * id is claimed — that is `adr next` and `adr resolve`. It refuses to overwrite, because the file
 * it would clobber is a decision the repository already made.
 */
import {Effect, type FileSystem, type Path, Result} from "effect";
import {exists, writeFile} from "../io/fs.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {isFourDigitId, isKebabSlug} from "./records.ts";
import {parseTags, recordFilename, renderTemplate, titleFromSlug} from "./template.ts";

/** The target path already exists — refused, never overwritten. */
export const ALREADY_EXISTS = 3;
/** `<id>` is not four digits, or `<slug>` is not kebab-case. */
export const BAD_ARGUMENT = 4;

export interface NewOptions {
	readonly id: string;
	readonly slug: string;
	readonly dir: string;
	readonly status: string;
	readonly date: string;
	readonly title: string | null;
	readonly tags: string | null;
	readonly json: boolean;
}

export const runNew = (
	options: NewOptions,
): Effect.Effect<VerbOutcome, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const {id, slug, dir, status, date, json} = options;
		if (!isFourDigitId(id)) {
			return refuse(BAD_ARGUMENT, `adr new: id "${id}" is not four zero-padded digits.`);
		}
		if (!isKebabSlug(slug)) {
			return refuse(
				BAD_ARGUMENT,
				`adr new: slug "${slug}" is not kebab-case (lowercase letters, digits and single hyphens).`,
			);
		}

		const path = `${dir.replace(/\/+$/, "")}/${recordFilename(id, slug)}`;
		const present = yield* Effect.result(exists(path));
		// A probe that could not RUN is not "absent": answering absent here would license a write over
		// a record this verb never managed to look at.
		if (Result.isFailure(present)) {
			return refuse(FAILED, `adr new: cannot check ${path}: ${present.failure.reason}`);
		}
		if (present.success) {
			return refuse(ALREADY_EXISTS, `adr new: ${path} already exists — refusing to overwrite.`);
		}

		const text = renderTemplate({
			id,
			slug,
			title: options.title ?? titleFromSlug(slug),
			status,
			date,
			tags: options.tags === null ? [] : parseTags(options.tags),
		});
		const written = yield* Effect.result(writeFile(path, text));
		if (Result.isFailure(written)) {
			return refuse(FAILED, `adr new: cannot write ${path}: ${written.failure.reason}`);
		}

		return answer(json ? JSON.stringify({path, id, slug}) : path);
	});
