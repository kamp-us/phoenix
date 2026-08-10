/**
 * `adr resolve` — resolve ids to their real filename and state against a fetched base ref.
 *
 * `live` and `landed` split presence from authority, and the split is the point: presence alone is
 * what a caller wrongly reads as citable, and 36 of the 233 records on `main` are present and not
 * live. `in-flight` is a distinct state so a caller can refuse to cite a pull request that may
 * never merge (#4296), and the `detail` column carries the frontmatter `status:` verbatim so a
 * withdrawn or superseded record reads as such at the moment of citation (#4338).
 *
 * The filename is printed rather than derived: a slug is not derivable from a title — 0048 is
 * `ship-it-merge-actor`, not `single-merge-authority` — so a guessed slug is a dead link (#1777).
 */
import {Effect} from "effect";
import {originRepo, type Shell} from "../io/git.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {loadInFlight, loadMerged, readMergedRecord} from "./base-ref.ts";
import {isFourDigitId} from "./records.ts";
import {
	indexInFlight,
	indexMerged,
	type MergedRecord,
	renderResolution,
	resolveId,
} from "./resolve.ts";

/** `--base` could not be fetched, so every state is UNKNOWN. */
export const BASE_UNFETCHABLE = 3;
/** The open pull requests could not be enumerated, so `absent` cannot be told from `in-flight`. */
export const IN_FLIGHT_UNKNOWN = 4;
/** `--dir` could not be read at the fetched base ref, so every state is UNKNOWN. See `next-verb.ts`'s `DIR_UNREADABLE` for why this is a `3`+ code and not `1`, and why `5` stays vacated. */
export const DIR_UNREADABLE = 6;

export interface ResolveOptions {
	readonly ids: ReadonlyArray<string>;
	readonly dir: string;
	readonly base: string;
	readonly repo: string | null;
	readonly json: boolean;
}

export const runResolve = (options: ResolveOptions): Shell<VerbOutcome> =>
	Effect.gen(function* () {
		const {ids, dir, base, json} = options;

		for (const id of ids) {
			if (!isFourDigitId(id)) {
				return refuse(FAILED, `adr resolve: id "${id}" is not four zero-padded digits.`);
			}
		}

		let repo = options.repo;
		if (repo === null) {
			const resolved = yield* originRepo;
			if (resolved._tag === "Failure") {
				return refuse(
					FAILED,
					`adr resolve: cannot resolve --repo from the origin remote: ${resolved.reason}`,
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
					`adr resolve: cannot fetch ${base}: ${e.reason} — every state is UNKNOWN, never "absent".`,
				);
			}
			if (e._tag === "DirUnreadable") {
				return refuse(
					DIR_UNREADABLE,
					`adr resolve: cannot read ${dir} at ${base}: ${e.reason} — every state is UNKNOWN, never "absent".`,
				);
			}
			return refuse(FAILED, `adr resolve: ${dir} holds a record with an unparseable id: ${e.file}`);
		}
		const mergedSet = merged.value;

		// The duplicate check runs on ids alone, BEFORE any status read: two records claiming one id
		// makes every later answer arbitrary, so it is resolved as a refusal rather than by picking one.
		const named: MergedRecord[] = mergedSet.files.flatMap((file, i) => {
			const id = mergedSet.ids[i];
			return id === undefined ? [] : [{id, file, status: ""}];
		});
		const duplicates = indexMerged(named);
		if ("duplicate" in duplicates) {
			const {id, files} = duplicates.duplicate;
			return refuse(
				FAILED,
				`adr resolve: ${dir} at ${base} holds two records for id ${id}: ${files[0]}, ${files[1]}`,
			);
		}

		// Only the requested ids need their status read. A read that fails is a refusal, never a record
		// silently dropped — a dropped record would answer `absent` for an id that is right there.
		const records: MergedRecord[] = [];
		for (const {id, file} of named) {
			if (!ids.includes(id)) {
				records.push({id, file, status: ""});
				continue;
			}
			const record = yield* readMergedRecord(mergedSet.sha, dir, file, id);
			if (record === null) {
				return refuse(FAILED, `adr resolve: cannot read ${dir}/${file} at ${mergedSet.sha}`);
			}
			records.push(record);
		}

		const indexed = indexMerged(records);
		if ("duplicate" in indexed) {
			const {id, files} = indexed.duplicate;
			return refuse(
				FAILED,
				`adr resolve: ${dir} at ${base} holds two records for id ${id}: ${files[0]}, ${files[1]}`,
			);
		}

		const inFlight = yield* loadInFlight(repo, dir);
		if (inFlight._tag === "Err") {
			const e = inFlight.error;
			return refuse(
				IN_FLIGHT_UNKNOWN,
				e._tag === "PrListFailed"
					? `adr resolve: cannot enumerate open pull requests in ${repo}: ${e.reason} — "absent" is indistinguishable from "in-flight", so it is UNKNOWN.`
					: `adr resolve: cannot read PR #${e.pr}'s file list: ${e.reason} — the in-flight set is INCOMPLETE, so it is UNKNOWN.`,
			);
		}

		const open = indexInFlight(inFlight.value);
		const resolutions = ids.map((id) => resolveId(id, indexed.index, open));
		const scope = `adr resolve: scanned ${dir} at ${mergedSet.sha}, ${mergedSet.files.length} decision records; ${open.size} id(s) in flight across the open pull requests of ${repo}.`;

		return answer(
			json
				? JSON.stringify(
						resolutions.map((r) => ({
							id: r.id,
							state: r.state,
							file: r.file,
							detail: r.detail,
							baseRef: base,
							baseSha: mergedSet.sha,
						})),
					)
				: resolutions.map(renderResolution).join("\n"),
			[scope],
		);
	});
