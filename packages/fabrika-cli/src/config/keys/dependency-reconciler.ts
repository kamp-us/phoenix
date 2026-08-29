/**
 * `dependencyReconciler` — the repo's own command that installs what its lockfile pins.
 *
 * An epic's assembly worktree is placed once and merged into many times. A child that adds a
 * workspace package moves the lockfile, and the tree's installed dependencies still predate it, so
 * the validators that run next compile against the pre-merge install: child #7162's merge failed
 * `pnpm typecheck --force` with `TS2688: Cannot find type definition file for 'node'` and passed all
 * 22 typechecks after an install, with no source or lockfile change (#7188).
 *
 * Declared rather than compiled in, for the reason `codeValidators` is: the command is the repo's
 * package manager and its own fail-closed flag — `--frozen-lockfile` is pnpm's, and a repo on
 * another manager spells the same intent differently. Same `command` argv grammar, so the file has
 * one shape for "a command fabrika spawns".
 *
 * **The shipped default is nothing declared, and nothing declared skips the step.** Unlike a
 * validator's absence, which refuses UNKNOWN because a green would claim the code was checked, an
 * absent reconciler claims nothing: a repo that vendors no dependencies has no install to run, and
 * refusing every epic integration in it would be a fence around an empty field. What phoenix
 * declares is the whole guarantee for phoenix.
 */

import {isRecord} from "../../io/json.ts";
import {trimmedStrings} from "../entries.ts";
import type {Decoded, KeyGroup} from "../key-group.ts";
import type {Argv} from "./workflow-validators.ts";

export const DEPENDENCY_RECONCILER = "dependencyReconciler";

/** The declared install, or `null` when the repo declares none. */
export type DependencyReconciler = {readonly argv: Argv} | null;

const MALFORMED = `\`${DEPENDENCY_RECONCILER}\` is not {"command": [non-empty argv of strings]} — e.g. {"command": ["pnpm", "install", "--frozen-lockfile"]}`;

const decode = (raw: unknown): Decoded<DependencyReconciler> => {
	if (raw === null) return {_tag: "Value", value: null};
	if (!isRecord(raw)) return {_tag: "Malformed", reason: MALFORMED};
	const command = trimmedStrings(raw.command);
	if (command === null) return {_tag: "Malformed", reason: MALFORMED};
	const [binary, ...args] = command;
	if (binary === undefined) return {_tag: "Malformed", reason: MALFORMED};
	return {_tag: "Value", value: {argv: [binary, ...args]}};
};

export const SHIPPED_DEPENDENCY_RECONCILER: DependencyReconciler = null;

export const dependencyReconcilerKey: KeyGroup<DependencyReconciler> = {
	key: DEPENDENCY_RECONCILER,
	shippedDefault: SHIPPED_DEPENDENCY_RECONCILER,
	decode,
	// `argv` is the spawn shape; the file's key is `command`, and a readout prints what the repo wrote.
	render: (reconciler) => (reconciler === null ? null : {command: [...reconciler.argv]}),
	jsonSchema: {
		type: ["object", "null"],
		description:
			"The repo's command that installs what its lockfile pins — `lane integrate` runs it in the assembly worktree after a clean child merge, before the code validators. Absent or null runs no install.",
		properties: {
			command: {
				type: "array",
				description: 'The argv to spawn — e.g. ["pnpm", "install", "--frozen-lockfile"].',
				items: {type: "string"},
				minItems: 1,
			},
		},
		required: ["command"],
		additionalProperties: false,
	},
};
