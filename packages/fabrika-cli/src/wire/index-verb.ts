/**
 * `wire index` — reconcile the wire-formats index doc with the registry, or render it again.
 *
 * Default is the check: it reds on the three divergences `./index-doc.ts` defines. `--write` is the
 * generator, and the reason the check is not one more hand-sync chore — the projection has a single
 * writer, so a stale region is fixed by re-rendering it rather than by retyping it.
 *
 * The doc arrives as an injected read and saving is an injected write, so both refusal paths are
 * driven in a test without a filesystem. A doc that could not be read is UNKNOWN (`6`), never "the
 * index disagrees": those two are the pair this group exists to keep apart.
 */
import {Effect} from "effect";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {ARTIFACT_UNKNOWN, MALFORMED, ZERO_SCOPE} from "./codes.ts";
import type {WireFormat} from "./format.ts";
import {conformIndexDoc, DOC_PATH, describeIndexFindings, rewriteIndexDoc} from "./index-doc.ts";

const VERB = "wire index";

/** The doc's bytes, or the reason they were never seen. */
export type DocRead =
	| {readonly _tag: "Text"; readonly text: string}
	| {readonly _tag: "Failed"; readonly reason: string};

export type DocSave = {readonly _tag: "Saved"} | {readonly _tag: "Failed"; readonly reason: string};

export interface IndexOptions<R> {
	readonly write: boolean;
	readonly json: boolean;
	readonly formats: ReadonlyArray<WireFormat>;
	readonly doc: Effect.Effect<DocRead, never, R>;
	readonly save: (markdown: string) => Effect.Effect<DocSave, never, R>;
}

const verdict = (
	json: boolean,
	outcome: "agrees" | "written",
	registered: number,
	documented: number,
): string =>
	json
		? `${JSON.stringify({doc: DOC_PATH, outcome, registered, documented})}\n`
		: `index\t${outcome}\t${registered}\t${documented}\n`;

export const runIndex = <R>({
	write,
	json,
	formats,
	doc,
	save,
}: IndexOptions<R>): Effect.Effect<VerbOutcome, never, R> =>
	Effect.gen(function* () {
		const source = yield* doc;
		if (source._tag === "Failed") {
			return refuse(
				ARTIFACT_UNKNOWN,
				`${VERB}: ${DOC_PATH} could not be read — UNKNOWN, never "the index agrees": ${source.reason}`,
			);
		}

		const scope = `${VERB}: judged ${DOC_PATH} (${source.text.length} bytes) against ${formats.length} registered formats.`;

		let markdown = source.text;
		if (write) {
			const rewritten = rewriteIndexDoc(markdown, formats);
			if (rewritten._tag === "ZeroScope") {
				return refuse(ZERO_SCOPE, `${VERB}: ${rewritten.reason}`, [scope]);
			}
			const saved = yield* save(rewritten.markdown);
			if (saved._tag === "Failed") {
				return refuse(
					ARTIFACT_UNKNOWN,
					`${VERB}: ${DOC_PATH} could not be written: ${saved.reason}`,
					[scope],
				);
			}
			markdown = rewritten.markdown;
		}

		const report = conformIndexDoc(markdown, formats);
		if (report._tag === "ZeroScope") {
			return refuse(ZERO_SCOPE, `${VERB}: ${report.reason}`, [scope]);
		}
		if (report.findings.length > 0) {
			return refuse(
				MALFORMED,
				`${VERB}: the index and the registry disagree — ${report.findings.length} finding(s)`,
				[
					scope,
					...describeIndexFindings(report.findings)
						.split("\n")
						.map((line) => `${VERB}: ${line}`),
				],
			);
		}

		return answer(
			verdict(json, write ? "written" : "agrees", report.registered, report.documented),
			[scope],
		);
	});
