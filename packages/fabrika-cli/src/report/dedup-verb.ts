import {Clock, type Crypto, Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {issueDocuments, listLabels, resolveRepo} from "../io/issues.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {NO_TARGET, QUEUE_UNREADABLE, SEARCH_UNREADABLE} from "./codes.ts";
import {loadIndex} from "./index-cache.ts";
import {
	closedCutoff,
	DEFAULT_CLOSED_DAYS,
	DuplicateIndex,
	renderIndexedCandidate,
} from "./issue-index.ts";

/**
 * `--label` does not exist in `--repo`, so the queue half has **no scope** — and a scope of zero
 * cannot produce a proven negative.
 *
 * A missing label is not a transport error, so `GET /issues?labels=<missing>` answers HTTP 200 with
 * `[]` and never reaches {@link QUEUE_UNREADABLE}. It lands on the success path, where an empty queue
 * is read as a fact, and the verb prints `none` — a proven negative over nothing scanned. The
 * code is `7` rather than a fresh number so it means what it already means on `report file`: *the
 * target named by `--label` does not exist in `--repo`*.
 */
export {NO_TARGET as LABEL_ABSENT};

export interface DedupOptions {
	readonly query: string;
	readonly closedDays?: number;
	readonly refresh?: boolean;
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
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path | Crypto.Crypto
> =>
	Effect.gen(function* () {
		const {label, limit, json, exclude} = options;
		const closedDays = options.closedDays ?? DEFAULT_CLOSED_DAYS;
		if (!Number.isSafeInteger(closedDays) || closedDays < 0 || closedDays > 36500)
			return refuse(FAILED, "report dedup: --closed-days must be an integer from 0 to 36500.");

		if (options.query.trim() === "") return refuse(FAILED, "report dedup: --query is empty.");
		if (!Number.isSafeInteger(limit) || limit < 0)
			return refuse(FAILED, `report dedup: --limit ${limit} is negative.`);

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

		const empty = new DuplicateIndex([]).search(options.query, [], limit, exclude);
		if (empty.outcome === "indeterminate") {
			return json
				? answer(
						JSON.stringify({
							...empty,
							queueCount: 0,
							indexCount: 0,
							cache: null,
							closedSince: null,
						}),
						[empty.reason ?? "indeterminate"],
					)
				: answer(empty.outcome, [empty.reason ?? "indeterminate"]);
		}
		const now = yield* Clock.currentTimeMillis;
		const queue = yield* issueDocuments(repo, {state: "open", label});
		const index = yield* loadIndex(repo, closedDays, now, options.refresh ?? false, options.env);
		if (queue._tag === "Failure")
			return refuse(
				QUEUE_UNREADABLE,
				`report dedup: cannot read the ${label} queue in ${repo}: ${queue.reason}${index._tag === "Failure" ? ` (the index also failed: ${index.reason})` : ""}. The outcome is UNKNOWN, never "none".`,
			);
		if (index._tag === "Failure")
			return refuse(
				SEARCH_UNREADABLE,
				`report dedup: cannot read the issue index for ${repo}: ${index.reason}. The outcome is UNKNOWN, never "none".`,
			);
		const result = new DuplicateIndex(index.value.issues).search(
			options.query,
			queue.value,
			limit,
			exclude,
		);
		const closedSince = closedDays === 0 ? null : closedCutoff(now, closedDays);
		const scope = `report dedup: ${repo}, ${queue.value.length} live queue issue(s), ${index.value.issues.length} indexed issue(s); all open plus closed since ${closedSince ?? "disabled"}; cache ${index.value.cache.source}, age ${index.value.cache.ageMs}ms; tokens: ${result.tokens.join(", ")}${exclude === null ? "" : `; #${exclude} excluded from both sources`}${result.truncated ? `; list TRUNCATED to --limit ${limit}` : ""}.`;
		const diagnostics = [...index.value.diagnostics, scope];
		if (result.retrievalTruncated)
			diagnostics.push(
				"report dedup: retrieval bounded to the top 20 title and top 20 title/body matches; more lexical matches exist.",
			);
		if (result.reason !== null) diagnostics.push(result.reason);
		return json
			? answer(
					JSON.stringify({
						...result,
						queueCount: queue.value.length,
						indexCount: index.value.issues.length,
						cache: index.value.cache,
						closedSince,
					}),
					diagnostics,
				)
			: answer(
					[result.outcome, ...result.candidates.map(renderIndexedCandidate)].join("\n"),
					diagnostics,
				);
	});
