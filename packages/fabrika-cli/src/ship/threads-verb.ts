/**
 * `ship threads` — every unresolved review thread, fully paginated, with the per-thread class facts
 * the skill's one retained judgment consumes.
 *
 * `0` is a valid, **proven** answer: nothing unresolved. An unreadable payload is `11`, never `0` —
 * the difference between "no open threads" and "I could not tell" is the whole gate.
 *
 * This verb answers *which threads are open and by whom*. It does not recompute
 * `unresolved-threads-guard.yml`'s accounting question (is every open thread named in the verdict);
 * that one is enforced and stays there.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {INCOMPLETE_SCAN, PRECONDITION_UNKNOWN} from "./codes.ts";
import {listReviewThreads} from "./github.ts";
import {badNumber, resolvePull, resolveTargetRepo, scannedLine} from "./target.ts";
import {classOfThread, excerptOf, openingAuthorOf, siteOf} from "./threads.ts";

const VERB = "ship threads";

export interface ThreadsOptions {
	readonly pr: number;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export const runThreads = (
	options: ThreadsOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {pr, json} = options;
		const bad = badNumber(VERB, "a pull-request number", pr);
		if (bad !== null) return bad;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const unreadable = (reason: string): string =>
			`${VERB}: cannot read #${pr}'s review threads: ${reason} — UNKNOWN, never zero.`;

		const target = yield* resolvePull(VERB, repo, pr, {unknownMessage: unreadable});
		if (target._tag === "Refused") return target.outcome;

		const listed = yield* listReviewThreads(repo, pr);
		if (listed._tag === "Failure") return refuse(PRECONDITION_UNKNOWN, unreadable(listed.reason));
		const {declared, threads} = listed.value;
		const diagnostics = [scannedLine(VERB, threads.length, "thread", `${declared} declared`)];
		if (threads.length < declared) {
			return refuse(
				INCOMPLETE_SCAN,
				`${VERB}: received ${threads.length} of ${declared} threads — refusing the partial sweep.`,
				diagnostics,
			);
		}
		// Both layers are count-proved: v1 read one comment per thread, so a human's reply on a bot
		// thread was invisible and the thread stayed bot-resolvable.
		const short = threads.find((thread) => thread.comments.length < thread.declaredComments);
		if (short !== undefined) {
			return refuse(
				INCOMPLETE_SCAN,
				`${VERB}: received ${short.comments.length} of ${short.declaredComments} comments on thread ${short.id} — refusing the partial sweep.`,
				diagnostics,
			);
		}

		const open = threads.filter((thread) => !thread.isResolved);
		return json
			? answer(
					JSON.stringify({
						outcome: "threads",
						count: open.length,
						threads: open.map((thread) => ({
							id: thread.id,
							class: classOfThread(thread),
							site: siteOf(thread),
							author: openingAuthorOf(thread),
							authors: thread.comments.map((comment) => comment.author),
							excerpt: excerptOf(thread),
						})),
						scanned: threads.length,
					}),
					diagnostics,
				)
			: answer(
					[
						`threads\t${open.length}`,
						...open.map((thread) =>
							[
								"thread",
								thread.id,
								classOfThread(thread),
								siteOf(thread),
								openingAuthorOf(thread),
								excerptOf(thread),
							].join("\t"),
						),
					].join("\n"),
					diagnostics,
				);
	});
