/**
 * Gather the evidence for every check `table prep` brings back: the issue, the timelines of its pull
 * requests and its own issues, whether its check comment already stands, and each evidence source's
 * output. Only reads and the sources run here; prep writes after every one of them has answered.
 *
 * A GitHub read that fails stops prep before any write, as every other prep read does. A source that
 * fails does not: its failure is part of the evidence.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9821
 */

import {Effect} from "effect";
import type {TableSettings} from "../config/keys/table.ts";
import type {ChildOutcome, ChildRequest} from "../io/exec.ts";
import type {Attempt} from "../io/git.ts";
import type {Existence, IssueRecord, TimelineFacts} from "../io/issues.ts";
import {PASSED_THROUGH} from "../spike/run-verb.ts";
import type {LaneRecord} from "../wire/lane-record.ts";
import type {CheckRow} from "./agenda.ts";
import {
	checkRowOf,
	type DueCheck,
	type Evidence,
	fabrikaNumbersOf,
	hasCheckComment,
	isFabrikaWork,
	prsOf,
	renderCheck,
	SOURCE_CAPTURE_BYTES,
	type SourceResult,
	signalsOf,
	sourceEnv,
	sourceResultOf,
	successOf,
} from "./check.ts";
import {PRECONDITION_UNKNOWN} from "./codes.ts";
import {issuesOf} from "./group.ts";
import type {Refusal} from "./sync-verb.ts";

/** The reads and the one run a check needs, passed in so prep stays provable offline. */
export interface CheckBoard<R> {
	readonly issue: (repo: string, issue: number) => Effect.Effect<Existence<IssueRecord>, never, R>;
	readonly timeline: (
		repo: string,
		issue: number,
	) => Effect.Effect<Attempt<TimelineFacts>, never, R>;
	readonly comments: (
		repo: string,
		issue: number,
	) => Effect.Effect<Attempt<ReadonlyArray<string>>, never, R>;
	readonly source: (request: ChildRequest) => Effect.Effect<ChildOutcome, never, R>;
}

/** One check ready to write: its evidence, the comment for its issue, and its row's cells. */
export interface GatheredCheck {
	readonly evidence: Evidence;
	/** The comment to post, or `null` when the issue already carries its check comment. */
	readonly comment: string | null;
	readonly row: CheckRow;
}

export interface Gathered {
	readonly _tag: "Gathered";
	readonly checks: ReadonlyArray<GatheredCheck>;
	/** Rows due whose issue is gone, left at `shipped`. */
	readonly vanished: ReadonlyArray<number>;
}

export interface GatherInput {
	readonly verb: string;
	readonly repo: string;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly settings: TableSettings;
	readonly now: Date;
	readonly due: ReadonlyArray<DueCheck>;
	readonly records: ReadonlyMap<number, ReadonlyArray<LaneRecord>>;
}

const refused = (code: number, reason: string): Refusal => ({_tag: "Refused", code, reason});

interface Timelines {
	readonly _tag: "Timelines";
	readonly facts: ReadonlyMap<number, TimelineFacts>;
}

const inherited = (env: Readonly<Record<string, string | undefined>>): Record<string, string> => {
	const kept: Record<string, string> = {};
	for (const name of PASSED_THROUGH) {
		const value = env[name];
		if (value !== undefined) kept[name] = value;
	}
	return kept;
};

export const gatherChecks = <R>(
	board: CheckBoard<R>,
	input: GatherInput,
): Effect.Effect<Gathered | Refusal, never, R> =>
	Effect.gen(function* () {
		const {verb, repo, settings} = input;
		const unread = (what: string, reason: string) =>
			refused(
				PRECONDITION_UNKNOWN,
				`${verb}: cannot read ${what}: ${reason}. Nothing was written.`,
			);
		const timelines = (
			numbers: ReadonlyArray<number>,
		): Effect.Effect<Timelines | Refusal, never, R> =>
			Effect.gen(function* () {
				const facts = new Map<number, TimelineFacts>();
				for (const number of numbers) {
					const read = yield* board.timeline(repo, number);
					if (read._tag === "Failure") return unread(`#${number}'s timeline`, read.reason);
					facts.set(number, read.value);
				}
				return {_tag: "Timelines", facts};
			});

		const checks: GatheredCheck[] = [];
		const vanished: number[] = [];
		for (const check of input.due) {
			const head = check.group.head;
			const issue = yield* board.issue(repo, head);
			if (issue._tag === "Unknown") return unread(`#${head}`, issue.reason);
			if (issue._tag === "Absent") {
				vanished.push(head);
				continue;
			}
			const prs = prsOf(check.group, input.records);
			const prTimelines = yield* timelines(prs);
			if (prTimelines._tag === "Refused") return prTimelines;
			const issueTimelines = yield* timelines(issuesOf(check.group));
			if (issueTimelines._tag === "Refused") return issueTimelines;
			const comments = yield* board.comments(repo, head);
			if (comments._tag === "Failure") return unread(`#${head}'s comments`, comments.reason);

			const sources: SourceResult[] = [];
			for (const source of settings.evidenceSources) {
				const [file, ...args] = source.command;
				const outcome = yield* board.source({
					file,
					args,
					cwd: input.cwd,
					env: {...inherited(input.env), ...sourceEnv(repo, check, prs)},
					timeoutSeconds: source.timeoutSeconds,
					captureBytes: SOURCE_CAPTURE_BYTES,
				});
				sources.push(sourceResultOf(source, outcome));
			}

			const evidence: Evidence = {
				issue: head,
				shippedAt: check.shippedAt,
				success: successOf(issue.value.body),
				signals: signalsOf({
					check,
					prs,
					prTimelines: prTimelines.facts,
					issueTimelines: issueTimelines.facts,
					followUps: check.group._tag === "Epic" ? check.group.members : [],
				}),
				fabrika: isFabrikaWork(issue.value.labels, settings)
					? fabrikaNumbersOf(input.records, check.shippedAt, settings.checkDelayDays, input.now)
					: null,
				sources,
			};
			checks.push({
				evidence,
				comment: hasCheckComment(comments.value, head) ? null : renderCheck(evidence),
				row: checkRowOf(evidence, issue.value, settings),
			});
		}
		return {_tag: "Gathered", checks, vanished};
	});
