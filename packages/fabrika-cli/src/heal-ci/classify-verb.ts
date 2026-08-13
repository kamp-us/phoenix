/**
 * `heal-ci classify` — log text on stdin, one signature per context out of the closed table.
 *
 * **Pure.** It opens no socket and reads no repository, which is what makes a classification
 * reproducible from the bytes alone and every row of the taxonomy unit-testable against a fixture.
 *
 * Empty stdin is `3`, never `unclassified`: a verb that classified nothing and a verb that read
 * nothing must not answer the same way.
 */
import {Effect} from "effect";
import type {StdinRead} from "../io/stdin.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {EMPTY_STDIN} from "./codes.ts";
import {NULL_TOKEN, parseFrames} from "./frames.ts";
import {classifyLog} from "./signatures.ts";

const VERB = "heal-ci classify";

export interface ClassifyOptions {
	readonly json: boolean;
	readonly stdin: Effect.Effect<StdinRead>;
}

export const runClassify = (options: ClassifyOptions): Effect.Effect<VerbOutcome> =>
	options.stdin.pipe(
		Effect.map((read: StdinRead): VerbOutcome => {
			if (read._tag === "Failed") {
				return refuse(
					FAILED,
					`${VERB}: could not read stdin: ${read.reason} — the log is UNKNOWN, never empty.`,
				);
			}
			const stream = read._tag === "NoStdin" ? "" : read.text;
			if (stream.trim() === "") {
				return refuse(
					EMPTY_STDIN,
					`${VERB}: no log on stdin — an empty read is not an unclassified failure; pipe the bytes.`,
				);
			}

			const frames = parseFrames(stream);
			const rows = frames.map((frame) => {
				const verdict = classifyLog(frame.text);
				return verdict._tag === "Matched"
					? {
							context: frame.context,
							class: verdict.signature.class,
							signature: verdict.signature.id,
							line: verdict.line as number | null,
							notice: `${VERB}: ${frame.context}: matched ${verdict.signature.id} at line ${verdict.line} — ${verdict.signature.rationale}.`,
						}
					: {
							context: frame.context,
							class: "unclassified" as const,
							signature: NULL_TOKEN,
							line: null,
							notice: `${VERB}: ${frame.context}: no signature matched over ${verdict.lines} lines — default-deny, never "transient".`,
						};
			});

			const notices = rows.map((row) => row.notice);
			return options.json
				? answer(
						JSON.stringify({
							outcome: "classified",
							count: rows.length,
							contexts: rows.map((row) => ({
								context: row.context,
								class: row.class,
								signature: row.signature === NULL_TOKEN ? null : row.signature,
								line: row.line,
							})),
						}),
						notices,
					)
				: answer(
						[
							`classified\t${rows.length}`,
							...rows.map(
								(row) =>
									`class\t${row.context}\t${row.class}\t${row.signature}\t${row.line ?? NULL_TOKEN}`,
							),
						].join("\n"),
						notices,
					);
		}),
	);
