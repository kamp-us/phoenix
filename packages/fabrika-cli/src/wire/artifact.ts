/**
 * The artifact-on-stdin boundary: three inputs a reader must never fuse into one.
 *
 * `../io/stdin.ts` already keeps "the pipe held nothing" apart from "the pipe could not be read".
 * This module carries that distinction the rest of the way into an exit code, because for *this*
 * group the negative answer is the expected one — a body with no acceptance criteria is ordinary —
 * and an expected negative is the least-questioned place for an unseen input to hide.
 */
import type {StdinRead} from "../io/stdin.ts";
import {refuse, type VerbOutcome} from "../verb.ts";
import {ARTIFACT_UNKNOWN, EMPTY_ARTIFACT} from "./codes.ts";

export type Artifact =
	/** Bytes that can be judged. Never blank — a blank artifact refuses instead. */
	| {readonly _tag: "Bytes"; readonly text: string}
	/** Nothing to judge, seated on a proven refusal rather than on a negative answer. */
	| {readonly _tag: "Refusal"; readonly outcome: VerbOutcome};

/**
 * Classify what arrived on fd 0.
 *
 * A blank artifact refuses on {@link EMPTY_ARTIFACT} rather than answering `Absent`: a redirect that
 * fed nothing is far more likely than an issue body that is genuinely zero bytes, and the two are
 * byte-identical here. Refusing costs a caller one re-run; answering costs a proven-looking negative
 * over an artifact nobody ever saw.
 */
export const classifyArtifact = (verb: string, read: StdinRead): Artifact => {
	if (read._tag === "NoStdin" || read._tag === "Failed") {
		return {
			_tag: "Refusal",
			outcome: refuse(
				ARTIFACT_UNKNOWN,
				`${verb}: the artifact could not be read (${read.reason}) — UNKNOWN, never absent. Redirect the artifact in: ${verb} < body.md`,
			),
		};
	}
	if (read.text.trim() === "") {
		return {
			_tag: "Refusal",
			outcome: refuse(
				EMPTY_ARTIFACT,
				`${verb}: stdin was read and held nothing — an empty artifact is not an artifact to judge`,
			),
		};
	}
	return {_tag: "Bytes", text: read.text};
};

/** `<verb>: judged <n> lines (<b> bytes) against format <key>.` — printed on answers and refusals alike. */
export const judgedLine = (verb: string, key: string, artifact: string): string => {
	const lines = artifact.split("\n").length;
	return `${verb}: judged ${lines} line${lines === 1 ? "" : "s"} (${artifact.length} bytes) against format ${key}.`;
};
