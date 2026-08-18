/**
 * `wire doc-section` — print one markdown section of a document by heading.
 *
 * A pure lookup over stdin (or `--file`, lifted by the adapter into the same {@link StdinRead}
 * shape): no plugin-root discovery lands here, because the calling shell knows its own skill base
 * directory and pipes `<base>/contract.md` in (#5966). The refusals are the group's proven facts:
 * absent and duplicated are distinct codes, and a document that could not be read is UNKNOWN,
 * never absent (`./codes.ts`).
 */
import {Effect} from "effect";
import type {StdinRead} from "../io/stdin.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {classifyArtifact} from "./artifact.ts";
import {ABSENT, MALFORMED} from "./codes.ts";
import {extractSection} from "./doc-section.ts";

const VERB = "wire doc-section";

export interface DocSectionOptions<R> {
	readonly heading: string;
	readonly json: boolean;
	/** The document read, injected so the failed-read and TTY paths are testable without a descriptor. */
	readonly source: Effect.Effect<StdinRead, never, R>;
}

export const runDocSection = <R = never>({
	heading,
	json,
	source,
}: DocSectionOptions<R>): Effect.Effect<VerbOutcome, never, R> =>
	Effect.map(source, (piped) => {
		const artifact = classifyArtifact(VERB, piped);
		if (artifact._tag === "Refusal") return artifact.outcome;

		const lines = artifact.text.split("\n").length;
		const scope = `${VERB}: judged ${lines} line${lines === 1 ? "" : "s"} (${artifact.text.length} bytes) for heading "${heading.trim()}".`;

		const result = extractSection(artifact.text, heading);
		if (result._tag === "Absent") {
			return refuse(ABSENT, `${VERB}: absent — ${result.reason}`, [scope]);
		}
		if (result._tag === "Duplicated") {
			return refuse(MALFORMED, `${VERB}: duplicated — ${result.reason}`, [
				scope,
				`${VERB}: ${result.evidence}`,
			]);
		}
		const stdout = json
			? `${JSON.stringify({heading: heading.trim(), outcome: "found", line: result.heading.line, body: result.body})}\n`
			: `${result.body}\n`;
		return answer(stdout, [scope, `${VERB}: found at line ${result.heading.line}.`]);
	});
