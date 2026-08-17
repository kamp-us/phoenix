/**
 * The one read that turns `.decisions/` into a free id — shared by `adr next` and `adr mint`.
 *
 * It lives apart from either verb because both must fail on exactly the same reads for exactly the
 * same reasons: a second copy of this ladder is a second place for one of the four UNKNOWN branches
 * to quietly become an answer, and an allocator that answers over a half-read set mints a duplicate.
 * The caller supplies its own verb name so a refusal names the command the operator actually ran.
 */
import {Effect} from "effect";
import {originRepo, type Shell} from "../io/git.ts";
import {refuse, type VerbOutcome} from "../verb.ts";
import {loadInFlight, loadMerged} from "./base-ref.ts";
import {
	BASE_UNFETCHABLE,
	DIR_UNREADABLE,
	IN_FLIGHT_UNKNOWN,
	ORIGIN_REPO_UNRESOLVABLE,
	UNPARSEABLE_RECORD_ID,
} from "./codes.ts";
import {type Allocation, allocate} from "./next.ts";

export interface AllocationRequest {
	/** The verb name every refusal is prefixed with — `adr next`, `adr mint`. */
	readonly verb: string;
	readonly dir: string;
	readonly base: string;
	readonly repo: string | null;
}

export interface AllocationFacts {
	readonly allocation: Allocation;
	/** The repo whose open pull requests formed the in-flight set — resolved, never the raw flag. */
	readonly repo: string;
	/** The base commit the merged set was read at. */
	readonly baseSha: string;
	/** The one-line account of what was scanned, for stderr. */
	readonly scope: string;
}

export type AllocationOutcome =
	| {readonly _tag: "Ok"; readonly value: AllocationFacts}
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome};

/** Allocate the next free id, refusing on any set that could not be read in full. */
export const resolveAllocation = (request: AllocationRequest): Shell<AllocationOutcome> =>
	Effect.gen(function* () {
		const {verb, dir, base} = request;

		let repo = request.repo;
		if (repo === null) {
			const resolved = yield* originRepo;
			if (resolved._tag === "Failure") {
				return {
					_tag: "Refused",
					outcome: refuse(
						ORIGIN_REPO_UNRESOLVABLE,
						`${verb}: cannot resolve --repo from the origin remote: ${resolved.reason} — the in-flight set is UNKNOWN.`,
					),
				};
			}
			repo = resolved.value;
		}

		const merged = yield* loadMerged(base, dir);
		if (merged._tag === "Err") {
			const e = merged.error;
			if (e._tag === "FetchFailed") {
				return {
					_tag: "Refused",
					outcome: refuse(
						BASE_UNFETCHABLE,
						`${verb}: cannot fetch ${base}: ${e.reason} — the merged set is UNKNOWN. Re-run; do not answer from the local tree.`,
					),
				};
			}
			if (e._tag === "DirUnreadable") {
				return {
					_tag: "Refused",
					outcome: refuse(
						DIR_UNREADABLE,
						`${verb}: cannot read ${dir} at ${base}: ${e.reason} — the merged set is UNKNOWN, never "0 records".`,
					),
				};
			}
			return {
				_tag: "Refused",
				outcome: refuse(
					UNPARSEABLE_RECORD_ID,
					`${verb}: ${dir} holds a record with an unparseable id: ${e.file}`,
				),
			};
		}

		const inFlight = yield* loadInFlight(repo, dir);
		if (inFlight._tag === "Err") {
			const e = inFlight.error;
			return {
				_tag: "Refused",
				outcome: refuse(
					IN_FLIGHT_UNKNOWN,
					e._tag === "PrListFailed"
						? `${verb}: cannot enumerate open pull requests in ${repo}: ${e.reason} — the in-flight set is UNKNOWN, never "nothing reserved". Re-run; do not fall back to the on-disk id.`
						: `${verb}: cannot read PR #${e.pr}'s file list: ${e.reason} — the in-flight set is INCOMPLETE, so it is UNKNOWN.`,
				),
			};
		}

		const allocation = allocate(
			merged.value.ids,
			inFlight.value.map((r) => r.id),
		);

		return {
			_tag: "Ok",
			value: {
				allocation,
				repo,
				baseSha: merged.value.sha,
				scope: `${verb}: scanned ${dir} at ${merged.value.sha}, ${merged.value.files.length} decision records; ${allocation.inFlight.length} id(s) in flight across the open pull requests of ${repo}.`,
			},
		};
	});
