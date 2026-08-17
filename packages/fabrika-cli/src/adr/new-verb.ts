/**
 * `adr new` — scaffold one record from the canonical template.
 *
 * Not a judging verb: it writes exactly one file, never edits another, and never checks whether the
 * id is claimed — that is `adr next`, `adr mint` and `adr resolve`. It refuses to overwrite, because
 * the file it would clobber is a decision the repository already made.
 *
 * {@link scaffold} is the write itself, exported so `adr mint` performs the same write rather than a
 * second one that could drift from it.
 */
import {Effect, type FileSystem, type Path, Result} from "effect";
import {exists, writeFile} from "../io/fs.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {ALREADY_EXISTS} from "./codes.ts";
import {isFourDigitId, isKebabSlug} from "./records.ts";
import {parseTags, recordFilename, renderTemplate, titleFromSlug} from "./template.ts";

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

/**
 * The slug rule as a refusal, exported so `adr mint` can apply it before it pays for the allocation
 * read — a usage error should not cost a fetch and a full pull-request enumeration first.
 */
export const refuseUnlessKebabSlug = (slug: string, verb: string): VerbOutcome | null =>
	isKebabSlug(slug)
		? null
		: refuse(
				FAILED,
				`${verb}: slug "${slug}" is not kebab-case (lowercase letters, digits and single hyphens).`,
			);

export type ScaffoldOutcome =
	| {readonly _tag: "Ok"; readonly path: string}
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome};

/**
 * Validate the id and slug, then write the record — refusing over anything already at that path.
 *
 * `verb` prefixes every refusal so the message names the command the operator ran.
 */
export const scaffold = (
	options: Omit<NewOptions, "json">,
	verb: string,
): Effect.Effect<ScaffoldOutcome, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const {id, slug, dir, status, date} = options;
		// A malformed id or slug is a usage error, so it exits 1 with the rest of them — `adr resolve`
		// already refuses a non-four-digit id there, and one fact on two numbers is the defect the
		// group table ends (#5294).
		if (!isFourDigitId(id)) {
			return {
				_tag: "Refused",
				outcome: refuse(FAILED, `${verb}: id "${id}" is not four zero-padded digits.`),
			};
		}
		const badSlug = refuseUnlessKebabSlug(slug, verb);
		if (badSlug !== null) return {_tag: "Refused", outcome: badSlug};

		const path = `${dir.replace(/\/+$/, "")}/${recordFilename(id, slug)}`;
		const present = yield* Effect.result(exists(path));
		// A probe that could not RUN is not "absent": answering absent here would license a write over
		// a record this verb never managed to look at.
		if (Result.isFailure(present)) {
			return {
				_tag: "Refused",
				outcome: refuse(FAILED, `${verb}: cannot check ${path}: ${present.failure.reason}`),
			};
		}
		if (present.success) {
			return {
				_tag: "Refused",
				outcome: refuse(ALREADY_EXISTS, `${verb}: ${path} already exists — refusing to overwrite.`),
			};
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
			return {
				_tag: "Refused",
				outcome: refuse(FAILED, `${verb}: cannot write ${path}: ${written.failure.reason}`),
			};
		}

		return {_tag: "Ok", path};
	});

export const runNew = (
	options: NewOptions,
): Effect.Effect<VerbOutcome, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const written = yield* scaffold(options, "adr new");
		if (written._tag === "Refused") return written.outcome;

		return answer(
			options.json
				? JSON.stringify({path: written.path, id: options.id, slug: options.slug})
				: written.path,
		);
	});
