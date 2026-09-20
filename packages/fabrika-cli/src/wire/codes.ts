/**
 * The one exit table every `wire` verb allocates from, so a code means one thing across the group.
 *
 * `wire codes` exposes {@link WIRE_EXIT_TABLE}; each verb's `--help` states what triggers its codes.
 * Keep {@link ARTIFACT_UNKNOWN} apart from {@link ABSENT}: an unread input proves no absence.
 */

import {NO_IMPLEMENTATION} from "../verb.ts";

/** The answer is on stdout. Restated here because {@link WIRE_EXIT_TABLE} spans the whole matrix. */
const ANSWER = 0;
/** Usage error, or the verb failed to run. */
const FAILED = 1;

/** The artifact was read and the format's block is provably not in it. A proven negative. */
export const ABSENT = 3;
/** The block is present and does not conform. A proven negative, distinct from {@link ABSENT}. */
export const MALFORMED = 4;
/** Stdin was read and held nothing. An empty artifact is not an artifact to judge. */
export const EMPTY_ARTIFACT = 5;
/**
 * fd 0 carried nothing readable, or the read failed. The artifact is **UNKNOWN**.
 *
 * Deliberately not {@link ABSENT}: "I could not see it" and "it is not there" are the two the
 * group exists to keep apart. Deliberately not `1` either — `1` is also what a bad flag and a
 * failed module load return, so a proven outcome seated there is unreadable as proof.
 */
export const ARTIFACT_UNKNOWN = 6;
/**
 * Zero scope: `--format` names no registered format, or the registry holds no rows at all.
 *
 * A checker asked for a format it does not have must red, not pass — a `check` that judged
 * nothing and exited 0 is a vacuous pass, the fail-open shape every guard in this tree refuses.
 */
export const ZERO_SCOPE = 7;
/** The fields on stdin hold nothing this format can compose a block from. */
export const UNUSABLE_FIELDS = 8;

/** The verb never ran (unresolved binary). The shell's, not this process's — no constant owns it. */
const NEVER_RAN = 127;

/** One row of the shared matrix: a code and the single meaning it carries across the group. */
export interface ExitCodeRow {
	readonly code: number;
	readonly meaning: string;
}

/**
 * The whole matrix in ascending order — the machine-readable form of the group's exit contract.
 *
 * The reserved rows sit beside the allocated ones because the matrix owns what a code *means*
 * while each verb's `--help` owns what *triggers* it.
 */
export const WIRE_EXIT_TABLE: ReadonlyArray<ExitCodeRow> = [
	{code: ANSWER, meaning: "the answer is on stdout"},
	{code: FAILED, meaning: "usage error, or the verb failed to run"},
	{code: ABSENT, meaning: "the artifact was read and the format's block is proven absent"},
	{code: MALFORMED, meaning: "the block is present and does not conform"},
	{code: EMPTY_ARTIFACT, meaning: "stdin was read and held nothing"},
	{
		code: ARTIFACT_UNKNOWN,
		meaning: "the artifact could not be read — UNKNOWN, never absent",
	},
	{
		code: ZERO_SCOPE,
		meaning: "zero scope: --format names no registered format, or the registry is empty",
	},
	{code: UNUSABLE_FIELDS, meaning: "the fields on stdin hold nothing this format can compose"},
	{code: NO_IMPLEMENTATION, meaning: "no implementation could be resolved"},
	{code: NEVER_RAN, meaning: "the verb never ran (unresolved binary)"},
];
