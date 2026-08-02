/**
 * `adr new` — scaffold one record from the canonical template.
 *
 * Not a judging verb: it writes exactly one file, never edits another, and never checks whether the
 * id is claimed — that is `adr next` and `adr resolve`. It refuses to overwrite, because the file
 * it would clobber is a decision the repository already made.
 */
import type {FileSystemLike} from "../io/fs.ts";
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

export const runNew = (fs: FileSystemLike, options: NewOptions): VerbOutcome => {
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
	if (fs.exists(path)) {
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
	if (!fs.writeFile(path, text)) {
		return refuse(FAILED, `adr new: cannot write ${path}: the write failed`);
	}

	return answer(json ? JSON.stringify({path, id, slug}) : path);
};
