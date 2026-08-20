/**
 * The GitHub half of the in-flight read: which open pull requests already claim a `.decisions/` id.
 *
 * Reads go through the `gh-api` client's REST leg and **never GraphQL** — the org's Projects-classic
 * integration errors out GraphQL issue queries — and **every list read pages**: a pull request that
 * adds its `.decisions/` file past file #100 still claims its number (#725), so a single unpaginated
 * page is a silently short answer, not a shorter one.
 *
 * Both reads below validate the SHAPE of what arrived before anything interprets it, and refuse a
 * payload that is not it. That discipline predates the port and survives it: a permissive read would
 * turn a wrong-shape payload into an empty in-flight set — which a caller reads as "nothing
 * reserved", the exact collision this module exists to remove.
 */

import {Effect} from "effect";
import {authed, pagedWithLinkProof} from "./gh-api.ts";
import {type Attempt, fail, ok, type Shell} from "./git.ts";
import {isRecord} from "./json.ts";

/** A `.decisions/NNNN[a]-slug.md` path an open pull request adds. */
export interface ClaimedId {
	readonly id: string;
	readonly file: string;
	readonly pr: number;
}

/** The known `status` values of a pull-request file entry — the shape guard's allowed set. */
const FILE_STATUS = new Set([
	"added",
	"removed",
	"modified",
	"renamed",
	"copied",
	"changed",
	"unchanged",
]);

/** The record id a `.decisions/NNNN[a]-slug.md` path claims, or `null` for any other path. */
export const claimedIdOf = (path: string, dir: string): {id: string; file: string} | null => {
	const prefix = `${dir.replace(/\/+$/, "")}/`;
	if (!path.startsWith(prefix)) return null;
	const file = path.slice(prefix.length);
	if (file.includes("/")) return null;
	const m = /^(\d{4}[a-z]*)-[a-z0-9-]+\.md$/.exec(file);
	return m?.[1] === undefined ? null : {id: m[1], file};
};

/** Every open pull request number in `repo`, paged. */
export const openPullRequests = (repo: string): Shell<Attempt<ReadonlyArray<number>>> =>
	authed((token) =>
		Effect.gen(function* () {
			const page = yield* pagedWithLinkProof(token, `repos/${repo}/pulls?state=open`);
			if (page._tag === "Failure") return page;
			if (!page.value.exhausted) return fail("the open pull request list was not read to its end");
			const numbers: number[] = [];
			for (const entry of page.value.entries) {
				if (!isRecord(entry) || typeof entry.number !== "number") {
					return fail("GitHub answered 200 but its output is not a list of pull requests");
				}
				numbers.push(entry.number);
			}
			return ok(numbers);
		}),
	);

/** The `.decisions/` ids one open pull request ADDS, paged over its file list. */
export const idsClaimedByPr = (
	repo: string,
	pr: number,
	dir: string,
): Shell<Attempt<ReadonlyArray<ClaimedId>>> =>
	authed((token) =>
		Effect.gen(function* () {
			const page = yield* pagedWithLinkProof(token, `repos/${repo}/pulls/${pr}/files`);
			if (page._tag === "Failure") return page;
			if (!page.value.exhausted) return fail(`PR #${pr}'s file list was not read to its end`);
			const claimed: ClaimedId[] = [];
			for (const entry of page.value.entries) {
				const status = isRecord(entry) ? entry.status : undefined;
				const filename = isRecord(entry) ? entry.filename : undefined;
				if (
					typeof status !== "string" ||
					typeof filename !== "string" ||
					!FILE_STATUS.has(status)
				) {
					return fail("GitHub answered 200 but its output is not a list of file entries");
				}
				if (status !== "added") continue;
				const hit = claimedIdOf(filename, dir);
				if (hit !== null) claimed.push({id: hit.id, file: hit.file, pr});
			}
			return ok(claimed);
		}),
	);
