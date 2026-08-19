/**
 * The three widen-only keys of `.fabrika.jsonc`, in the shape their callers already read.
 *
 * The surface itself now lives in `config/`: one load, one parse, one module per key group
 * (`config/registry.ts`). This file is the adapter for the three keys that predate it — their
 * callers open the bytes themselves, at a base ref (`build clearances`) or at the working root
 * (`build check`), and take a text-in / union-out reader.
 *
 * **All three are widen-only policy, where empty IS the strict answer**: nobody may grant, nothing
 * is exempt, this repo declares no validator. So each collapses the surface's `Default` and
 * `Malformed` arms into one `Unusable`, carrying the reason through unchanged, and an unreadable
 * file never reaches here — the callers refuse on it before opening these readers.
 */

import type {KeyGroup} from "./config/key-group.ts";
import {
	CAP_CLEAR_AUTHORS,
	capClearAuthorsKey,
	type GrantAuthor,
} from "./config/keys/cap-clear-authors.ts";
import {DOC_LEAK_EXEMPT, docLeakExemptKey} from "./config/keys/doc-leak-exempt.ts";
import {
	WORKFLOW_VALIDATORS,
	type WorkflowValidator,
	workflowValidatorsKey,
} from "./config/keys/workflow-validators.ts";
import {loadConfig, resolve} from "./config/load.ts";

export {CONFIG_PATH, stripJsonComments} from "./config/document.ts";
export type {Argv, WorkflowValidator} from "./config/keys/workflow-validators.ts";
export type {GrantAuthor};
export {CAP_CLEAR_AUTHORS, DOC_LEAK_EXEMPT, WORKFLOW_VALIDATORS};

/** The bytes were read in full and hold no usable value — the key's strictest answer. */
type Unusable = {readonly _tag: "Unusable"; readonly reason: string};

/**
 * One widen-only key's entries, or why there are none.
 *
 * `emptyReason` is the arm the surface itself has no opinion on: a declared-but-empty list is a
 * perfectly valid config, and it is these three keys — not the loader — that read empty as "nothing
 * usable" and say so in their own words.
 */
const entries = <A>(
	text: string,
	group: KeyGroup<ReadonlyArray<A>>,
	emptyReason: string,
): {readonly _tag: "Entries"; readonly entries: ReadonlyArray<A>} | Unusable => {
	const resolved = resolve(loadConfig({_tag: "Text", text}), group);
	if (resolved._tag === "Malformed" || resolved._tag === "Unknown") {
		return {_tag: "Unusable", reason: resolved.reason};
	}
	if (resolved._tag === "Default") return {_tag: "Unusable", reason: resolved.reason};
	return resolved.value.length === 0
		? {_tag: "Unusable", reason: emptyReason}
		: {_tag: "Entries", entries: resolved.value};
};

export type AuthorsRead =
	| {readonly _tag: "Authors"; readonly authors: ReadonlyArray<GrantAuthor>}
	| Unusable;

/** The grant-author set the config declares, or why nobody may clear a round. */
export const readCapClearAuthors = (text: string): AuthorsRead => {
	const read = entries(
		text,
		capClearAuthorsKey,
		`\`${CAP_CLEAR_AUTHORS}\` is empty — nobody may clear a round`,
	);
	return read._tag === "Entries" ? {_tag: "Authors", authors: read.entries} : read;
};

export type ExemptRead = {readonly _tag: "Paths"; readonly paths: ReadonlyArray<string>} | Unusable;

/** The leak-scan exemptions the config declares, or why nothing is exempt. */
export const readDocLeakExempt = (text: string): ExemptRead => {
	const read = entries(
		text,
		docLeakExemptKey,
		`\`${DOC_LEAK_EXEMPT}\` is empty — nothing is exempt`,
	);
	return read._tag === "Entries" ? {_tag: "Paths", paths: read.entries} : read;
};

export type ValidatorsRead =
	| {readonly _tag: "Validators"; readonly validators: ReadonlyArray<WorkflowValidator>}
	| Unusable;

/** The repo's own workflow validators, or why this repo declares none. */
export const readWorkflowValidators = (text: string): ValidatorsRead => {
	const read = entries(
		text,
		workflowValidatorsKey,
		`\`${WORKFLOW_VALIDATORS}\` is empty — this repo declares none`,
	);
	return read._tag === "Entries" ? {_tag: "Validators", validators: read.entries} : read;
};
