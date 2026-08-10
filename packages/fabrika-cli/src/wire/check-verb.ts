/**
 * `wire check` — does the artifact on stdin carry a conforming block for this format?
 *
 * `read` without the payload: the same three-way total read, answered as a verdict token rather
 * than as fields, for a caller that only needs the yes/no. It shares `read`'s codes so one meaning
 * covers both, and it prints the scope it judged on **every** path — a verdict whose scope is
 * unstated cannot be told from a verdict over nothing (ADR 0092).
 */
import {Effect} from "effect";
import type {StdinRead} from "../io/stdin.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {classifyArtifact, judgedLine} from "./artifact.ts";
import {ABSENT, MALFORMED} from "./codes.ts";
import {resolveFormat} from "./resolve-format.ts";

const VERB = "wire check";

export interface CheckOptions {
	readonly format: string;
	readonly json: boolean;
	readonly stdin: Effect.Effect<StdinRead>;
}

export const runCheck = ({format, json, stdin}: CheckOptions): Effect.Effect<VerbOutcome> =>
	Effect.map(stdin, (piped) => {
		const lookup = resolveFormat(VERB, format);
		if (lookup._tag === "Refusal") return lookup.outcome;

		const artifact = classifyArtifact(VERB, piped);
		if (artifact._tag === "Refusal") return artifact.outcome;

		const scope = judgedLine(VERB, format, artifact.text);
		const result = lookup.format.read(artifact.text);
		if (result._tag === "Absent") {
			return refuse(ABSENT, `${VERB}: absent — ${result.reason}`, [scope]);
		}
		if (result._tag === "Malformed") {
			return refuse(MALFORMED, `${VERB}: malformed — ${result.reason}`, [
				scope,
				`${VERB}: ${result.evidence}`,
			]);
		}
		const stdout = json
			? `${JSON.stringify({format, outcome: "conforms", fields: result.value.length})}\n`
			: `conforms\t${format}\t${result.value.length}\n`;
		return answer(stdout, [scope]);
	});
