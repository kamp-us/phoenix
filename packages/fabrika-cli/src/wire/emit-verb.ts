/**
 * `wire emit` — compose a format's bytes from the fields on stdin.
 *
 * The fields arrive on **stdin only**, for the reason `triage split`'s body does: a flag that takes
 * a path turns the artifact into a string the verb could echo back, and that is how a machine-local
 * path reaches a public surface. A shell redirect is expected — the *shell* reads the file, so what
 * reaches the verb is already bytes.
 */
import {Effect} from "effect";
import type {StdinRead} from "../io/stdin.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {classifyArtifact} from "./artifact.ts";
import {UNUSABLE_FIELDS} from "./codes.ts";
import {resolveFormat} from "./resolve-format.ts";

const VERB = "wire emit";

export interface EmitOptions {
	readonly format: string;
	readonly json: boolean;
	readonly stdin: Effect.Effect<StdinRead>;
}

export const runEmit = ({format, json, stdin}: EmitOptions): Effect.Effect<VerbOutcome> =>
	Effect.map(stdin, (piped) => {
		const lookup = resolveFormat(VERB, format);
		if (lookup._tag === "Refusal") return lookup.outcome;

		const fields = classifyArtifact(VERB, piped);
		if (fields._tag === "Refusal") return fields.outcome;

		const composed = lookup.format.emit(fields.text);
		if (composed._tag === "Unusable") {
			return refuse(UNUSABLE_FIELDS, `${VERB}: unusable fields — ${composed.reason}`);
		}
		return answer(json ? `${JSON.stringify({format, bytes: composed.bytes})}\n` : composed.bytes);
	});
