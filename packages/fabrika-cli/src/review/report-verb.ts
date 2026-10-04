/**
 * `review report` — the PR body's `## Report` section state and, when it is there, its text.
 *
 * The verb reports a state and the author's words, never a grade: whether a criterion asked for a
 * report, and whether what the author wrote answers it, are the judgment layer's. What this makes
 * mechanical is the split a reviewer could not make by hand — `absent` is a proven fact about the
 * body, so a report-shaped criterion over it grades instead of ending UNKNOWN, and only a read that
 * failed leaves the state unread.
 *
 * It binds no commit: a PR body is not part of any tree, so there is no head to read it out of.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/8924#issuecomment-5625300585
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {answer, type VerbOutcome} from "../verb.ts";
import {REPORT_HEADING, type ReportRead, read as readReport} from "../wire/report.ts";
import {badNumber, openPull, resolveTargetRepo} from "./target.ts";

const VERB = "review report";

/** The verb's state words, one per answer of the registered read. */
const STATE = {Found: "found", Absent: "absent", Malformed: "malformed"} as const satisfies Record<
	ReportRead["_tag"],
	string
>;

export interface ReportOptions {
	readonly pr: number;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export const runReport = (
	options: ReportOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {pr, json} = options;
		const bad = badNumber(VERB, "a pull-request number", pr);
		if (bad !== null) return bad;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;

		const target = yield* openPull(VERB, resolved.repo, pr, {
			requireOpen: false,
			requireFiles: false,
			unknownMessage: (reason) =>
				`${VERB}: cannot read #${pr}'s body: ${reason} — the report state is UNKNOWN, never "absent".`,
		});
		if (target._tag === "Refused") return target.outcome;

		const report = readReport(target.pull.body);
		const state = STATE[report._tag];
		const diagnostic =
			report._tag === "Found"
				? `read #${pr}'s body; "${REPORT_HEADING}" at line ${report.value.line}, ${report.value.text.split("\n").length} line(s)`
				: report._tag === "Absent"
					? `${state} — ${report.reason}`
					: `${state} — ${report.reason} — ${report.evidence}`;
		const text = report._tag === "Found" ? report.value.text : null;
		return json
			? answer(JSON.stringify({outcome: state, text}), [`${VERB}: ${diagnostic}.`])
			: answer([`report\t${state}`, ...(text === null ? [] : [text])].join("\n"), [
					`${VERB}: ${diagnostic}.`,
				]);
	});
