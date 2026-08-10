/**
 * `report dedup` — rank the open issues that may already cover an observation.
 *
 * The verb **supplies an input; it does not judge**, which is why all three outcomes exit 0: the
 * check is advisory, never a gate on filing (ADR 0181). A duplicate is cheap for triage to close
 * and a lost observation is gone, so the skill files on ambiguity.
 *
 * The two halves are read for different reasons. The **label queue** is read-after-write consistent
 * and catches an issue filed seconds ago; the **search index** is eventually consistent — it lags
 * fresh issues but reaches older open issues that have already left the queue.
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {listLabels, openIssuesWithLabel, resolveRepo, searchOpenIssues} from "../io/issues.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {NO_TARGET, QUEUE_UNREADABLE, SEARCH_UNREADABLE} from "./codes.ts";
import {rank, renderCandidate, tokenize} from "./dedup.ts";

/**
 * `--label` does not exist in `--repo`, so the queue half has **no scope** — and a scope of zero
 * cannot produce a proven negative.
 *
 * Reported as a spec defect on #4752: a missing label is not
 * a transport error, so `GET /issues?labels=<missing>` answers HTTP 200 with `[]` and never reaches
 * {@link QUEUE_UNREADABLE}. It lands on the success path, where an empty queue is read as a fact,
 * and the verb prints `none` — a proven negative over nothing scanned, which ADR 0092 forbids. The
 * code is `7` rather than a fresh number so it means what it already means on `report file`: *the
 * target named by `--label` does not exist in `--repo`*.
 */
export {NO_TARGET as LABEL_ABSENT};

export interface DedupOptions {
	readonly query: string;
	readonly label: string;
	readonly limit: number;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** The issue being deduped, filtered from both sources so it never flags itself. */
	readonly exclude: number | null;
}

export const runDedup = (
	options: DedupOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {label, limit, json, exclude} = options;

		if (options.query.trim() === "") return refuse(FAILED, "report dedup: --query is empty.");
		if (limit < 0) return refuse(FAILED, `report dedup: --limit ${limit} is negative.`);

		const repoAttempt = yield* resolveRepo(options.repo, options.env);
		if (repoAttempt._tag === "Failure") {
			return refuse(
				FAILED,
				"report dedup: cannot resolve a target repo — set CLAUDE_PIPELINE_REPO, or run inside a checkout whose origin remote resolves.",
			);
		}
		const repo = repoAttempt.value;

		// The label precondition runs BEFORE either source read, because it is what makes the queue
		// half's scope non-zero. Reading it here also means an unreadable label set refuses as UNKNOWN
		// rather than resolving to "the label is missing".
		const labels = yield* listLabels(repo);
		if (labels._tag === "Failure") {
			return refuse(
				QUEUE_UNREADABLE,
				`report dedup: cannot read the label set of ${repo}: ${labels.reason} — whether the ${label} queue exists is UNKNOWN, and so is the outcome.`,
			);
		}
		if (!labels.value.includes(label)) {
			return refuse(
				NO_TARGET,
				`report dedup: ${repo} has no "${label}" label — the queue half would scan nothing, so the outcome is UNKNOWN, never "none". Create the label, or pass the one this repo uses.`,
			);
		}

		const tokens = tokenize(options.query);
		if (tokens.length < 2) {
			const result = rank({tokens, queue: [], search: [], limit, label, exclude});
			const scope = `report dedup: ${repo}, tokens: ${tokens.join(", ") || "(none)"} — neither source was read, because the query cannot discriminate.`;
			const diagnostics = [scope, `report dedup: ${result.reason}.`];
			return json
				? answer(
						JSON.stringify({
							outcome: result.outcome,
							candidates: [],
							reason: result.reason,
							tokens,
							truncated: false,
							queueCount: 0,
							searchCount: 0,
						}),
						diagnostics,
					)
				: answer(result.outcome, diagnostics);
		}

		const queue = yield* openIssuesWithLabel(repo, label);
		const search = yield* searchOpenIssues(repo, tokens);

		// The queue is the load-bearing half — it is the one that catches an issue filed seconds ago —
		// so when both fail its code is the one reported, and the reason names both failures so
		// neither is hidden by the precedence.
		if (queue._tag === "Failure") {
			const also =
				search._tag === "Failure" ? ` (the search index also failed: ${search.reason})` : "";
			return refuse(
				QUEUE_UNREADABLE,
				`report dedup: cannot read the ${label} queue in ${repo}: ${queue.reason}${also} — the outcome is UNKNOWN, never "none".`,
			);
		}
		if (search._tag === "Failure") {
			return refuse(
				SEARCH_UNREADABLE,
				`report dedup: cannot read the search index for ${repo}: ${search.reason} — the outcome is UNKNOWN, never "none".`,
			);
		}

		const result = rank({tokens, queue: queue.value, search: search.value, limit, label, exclude});
		const excluded = exclude === null ? "" : `; #${exclude} excluded from both sources`;
		const scope = `report dedup: ${repo}, ${queue.value.length} open issue(s) in the ${label} queue, ${search.value.length} search hit(s)${excluded}; tokens: ${tokens.join(", ")}${result.truncated ? `; list TRUNCATED to --limit ${limit}` : ""}.`;
		const diagnostics =
			result.reason === null ? [scope] : [scope, `report dedup: ${result.reason}.`];

		if (json) {
			return answer(
				JSON.stringify({
					outcome: result.outcome,
					candidates: result.candidates,
					reason: result.reason,
					tokens,
					truncated: result.truncated,
					queueCount: queue.value.length,
					searchCount: search.value.length,
				}),
				diagnostics,
			);
		}
		return answer(
			[result.outcome, ...result.candidates.map(renderCandidate)].join("\n"),
			diagnostics,
		);
	});
