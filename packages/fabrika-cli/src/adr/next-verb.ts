/**
 * `adr next` — the next unused ADR id, against a fetched base ref unioned with open ADR pull
 * requests.
 *
 * The residual race is real and this verb does not close it: two authors between the same pair of
 * invocations still collide. CI's decision-record validation reds the second-to-merge pull request,
 * and the skill's own re-check catches it for the caller's id before the pull request opens. A verb
 * that claimed to close it would be lying.
 */
import {Effect} from "effect";
import {originRepo, type Shell} from "../io/git.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {loadInFlight, loadMerged} from "./base-ref.ts";
import {allocate} from "./next.ts";

/** `--base` could not be fetched, so the merged set is UNKNOWN. */
export const BASE_UNFETCHABLE = 3;
/** The open pull requests could not be enumerated, so the in-flight set is UNKNOWN. */
export const IN_FLIGHT_UNKNOWN = 4;
/** `--dir` was read and held zero records — zero scope (ADR 0092). */
export const ZERO_SCOPE = 5;
/**
 * `--dir` could not be read at the fetched base ref, so the merged set is UNKNOWN.
 *
 * This is a proven outcome, so it takes a `3`+ code and not `1`: a caller that saw a refusal share
 * the failure-to-invoke code could not tell "the directory is not there at that ref" from "the verb
 * never ran" (#4208, #4219, #4736). `6` is the lowest code this verb's table had free — `3`, `4` and
 * `5` already carry other proven outcomes — and `resolve` seats the same state on the same number.
 */
export const DIR_UNREADABLE = 6;

export interface NextOptions {
	readonly dir: string;
	readonly base: string;
	readonly repo: string | null;
	readonly json: boolean;
}

export const runNext = (options: NextOptions): Shell<VerbOutcome> =>
	Effect.gen(function* () {
		const {dir, base, json} = options;

		let repo = options.repo;
		if (repo === null) {
			const resolved = yield* originRepo;
			if (resolved._tag === "Failure") {
				return refuse(
					FAILED,
					`adr next: cannot resolve --repo from the origin remote: ${resolved.reason}`,
				);
			}
			repo = resolved.value;
		}

		const merged = yield* loadMerged(base, dir);
		if (merged._tag === "Err") {
			const e = merged.error;
			if (e._tag === "FetchFailed") {
				return refuse(
					BASE_UNFETCHABLE,
					`adr next: cannot fetch ${base}: ${e.reason} — the merged set is UNKNOWN. Re-run; do not answer from the local tree.`,
				);
			}
			if (e._tag === "DirUnreadable") {
				return refuse(
					DIR_UNREADABLE,
					`adr next: cannot read ${dir} at ${base}: ${e.reason} — the merged set is UNKNOWN, never "0 records".`,
				);
			}
			if (e._tag === "UnparseableId") {
				return refuse(FAILED, `adr next: ${dir} holds a record with an unparseable id: ${e.file}`);
			}
			return refuse(
				ZERO_SCOPE,
				`adr next: scanned ${dir} at ${base}, 0 decision records — refusing to answer (ADR 0092).`,
			);
		}

		const inFlight = yield* loadInFlight(repo, dir);
		if (inFlight._tag === "Err") {
			const e = inFlight.error;
			return refuse(
				IN_FLIGHT_UNKNOWN,
				e._tag === "PrListFailed"
					? `adr next: cannot enumerate open pull requests in ${repo}: ${e.reason} — the in-flight set is UNKNOWN, never "nothing reserved". Re-run; do not fall back to the on-disk id.`
					: `adr next: cannot read PR #${e.pr}'s file list: ${e.reason} — the in-flight set is INCOMPLETE, so it is UNKNOWN.`,
			);
		}

		const allocation = allocate(
			merged.value.ids,
			inFlight.value.map((r) => r.id),
		);
		const scope = `adr next: scanned ${dir} at ${merged.value.sha}, ${merged.value.files.length} decision records; ${allocation.inFlight.length} id(s) in flight across the open pull requests of ${repo}.`;

		return answer(
			json
				? JSON.stringify({
						id: allocation.id,
						mergedMax: allocation.mergedMax,
						inFlight: allocation.inFlight,
						baseRef: base,
						baseSha: merged.value.sha,
					})
				: allocation.id,
			[scope],
		);
	});
