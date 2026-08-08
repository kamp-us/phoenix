/**
 * `wire read` — read a format's block out of an artifact on stdin.
 *
 * The one verb whose *negative* answers are the point. `Found` is the only outcome that reaches
 * stdout; `Absent` and `Malformed` are proven refusals on distinct codes, and an artifact that was
 * never seen is a third code again (`./codes.ts`). Nothing here can produce a well-formed empty
 * answer.
 */
import {Effect} from "effect";
import type {StdinRead} from "../io/stdin.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {classifyArtifact, judgedLine} from "./artifact.ts";
import {ABSENT, MALFORMED} from "./codes.ts";
import {resolveFormat} from "./resolve-format.ts";

const VERB = "wire read";

export interface ReadOptions {
	readonly format: string;
	readonly json: boolean;
	/** The fd-0 read, injected so the failed-read and TTY paths are testable without a descriptor. */
	readonly stdin: Effect.Effect<StdinRead>;
}

export const runRead = ({format, json, stdin}: ReadOptions): Effect.Effect<VerbOutcome> =>
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
			? `${JSON.stringify({format, outcome: "found", fields: result.value})}\n`
			: `found\t${format}\t${result.value.length}\n${result.value.join("\n")}\n`;
		return answer(stdout, [scope]);
	});
