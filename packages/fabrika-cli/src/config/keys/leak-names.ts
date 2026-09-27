/**
 * `leakNames` — the names this repo keeps out of public bodies, beside the leak predicate's
 * structural shapes.
 *
 * Two lists. `privateRepos` holds `owner/repo` slugs: the name alone may appear, but a link to the
 * repo or an `owner/repo#N` reference is a leak. `identifiers` holds any other string — a handle, a
 * name — whose every occurrence is a leak. The report group's writing verbs read it and hand it to
 * [`scanBody`](../../report/leaks.ts).
 *
 * The shipped default is both lists empty, so a repo that declares nothing gets the structural
 * shapes and nothing else. Which names are private differs repo by repo, and fabrika installs into
 * repos it does not control, so no name ships as a default.
 */

import {trimmedStrings} from "../entries.ts";
import type {Decoded, KeyGroup} from "../key-group.ts";

export const LEAK_NAMES = "leakNames";

export interface LeakNames {
	/** `owner/repo` slugs whose link or `#N` reference is a leak; the bare name is not. */
	readonly privateRepos: ReadonlyArray<string>;
	/** Strings whose every occurrence, case-insensitively, is a leak. */
	readonly identifiers: ReadonlyArray<string>;
}

export const NO_LEAK_NAMES: LeakNames = {privateRepos: [], identifiers: []};

/** One GitHub `owner/repo` slug: an owner login, one slash, a repository name that is not a dot path. */
const SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/(?!\.\.?$)[A-Za-z0-9._-]+$/;

const KNOWN: ReadonlyArray<keyof LeakNames> = ["privateRepos", "identifiers"];

const named = (path: string): string => `\`${LEAK_NAMES}\`'s \`${path}\``;

const asRecord = (raw: unknown): Record<string, unknown> | null =>
	typeof raw === "object" && raw !== null && !Array.isArray(raw)
		? (raw as Record<string, unknown>)
		: null;

const decodeList = (
	record: Record<string, unknown>,
	key: keyof LeakNames,
	expected: string,
): Decoded<ReadonlyArray<string>> => {
	const raw = record[key];
	if (raw === undefined) return {_tag: "Value", value: []};
	const values = trimmedStrings(raw);
	return values === null
		? {
				_tag: "Malformed",
				reason: `${named(key)} is not an array of non-empty strings — expected ${expected}`,
			}
		: {_tag: "Value", value: values};
};

const decode = (raw: unknown): Decoded<LeakNames> => {
	const record = asRecord(raw);
	if (record === null) return {_tag: "Malformed", reason: `\`${LEAK_NAMES}\` is not an object`};
	const stray = Object.keys(record).find((key) => !(KNOWN as ReadonlyArray<string>).includes(key));
	if (stray !== undefined) {
		return {
			_tag: "Malformed",
			reason: `${named(stray)} is not a leak-name list — one of ${KNOWN.join(", ")}`,
		};
	}

	const privateRepos = decodeList(record, "privateRepos", "`owner/repo` slugs");
	if (privateRepos._tag === "Malformed") return privateRepos;
	const notSlug = privateRepos.value.find((slug) => !SLUG.test(slug));
	if (notSlug !== undefined) {
		return {
			_tag: "Malformed",
			reason: `${named("privateRepos")} holds "${notSlug}", which is not an \`owner/repo\` slug`,
		};
	}

	const identifiers = decodeList(record, "identifiers", "the strings to refuse");
	if (identifiers._tag === "Malformed") return identifiers;

	return {_tag: "Value", value: {privateRepos: privateRepos.value, identifiers: identifiers.value}};
};

export const leakNamesKey: KeyGroup<LeakNames> = {
	key: LEAK_NAMES,
	shippedDefault: NO_LEAK_NAMES,
	decode,
	jsonSchema: {
		type: "object",
		description:
			"Names the report group's writing verbs keep out of public bodies, beside the structural leak shapes. Absent (or both lists empty) means only the structural shapes refuse.",
		properties: {
			privateRepos: {
				type: "array",
				description:
					"`owner/repo` slugs of private repositories. The bare name may appear; a github.com link to the repo or an `owner/repo#N` reference refuses.",
				items: {type: "string", pattern: SLUG.source},
			},
			identifiers: {
				type: "array",
				description:
					"Other names — a handle, a person's name — whose every occurrence refuses, matched case-insensitively.",
				items: {type: "string", minLength: 1},
			},
		},
		additionalProperties: false,
	},
};
