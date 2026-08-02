/**
 * The GitHub half of the in-flight read: which open pull requests already claim a `.decisions/` id.
 *
 * Reads go through `gh api` REST and **never GraphQL** — the org's Projects-classic integration
 * errors out GraphQL issue queries — and **every list read pages**: a pull request that adds its
 * `.decisions/` file past file #100 still claims its number (#725), so a single unpaginated page is
 * a silently short answer, not a shorter one.
 *
 * Both parsers below validate the SHAPE of what they read before anything interprets it, and hand
 * back `null` on a shape they did not expect. That is deliberate: `gh` can exit 0 having printed
 * something other than what was asked for, and a permissive parse would turn that into an empty
 * in-flight set — which a caller reads as "nothing reserved", the exact collision this exists to
 * remove.
 */

import type {Exec} from "./exec.ts";
import {type Attempt, fail, ok} from "./git.ts";

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

/** Pull request numbers from `--jq '.[].number'` output, or `null` when a line is not a number. */
export const parsePrNumbers = (stdout: string): ReadonlyArray<number> | null => {
	const lines = stdout.split("\n").filter((l) => l.trim() !== "");
	const out: number[] = [];
	for (const line of lines) {
		if (!/^\d+$/.test(line.trim())) return null;
		out.push(Number.parseInt(line.trim(), 10));
	}
	return out;
};

/** `status\tfilename` rows, or `null` when a row is not that shape. */
export const parseFileRows = (
	stdout: string,
): ReadonlyArray<{readonly status: string; readonly filename: string}> | null => {
	const lines = stdout.split("\n").filter((l) => l !== "");
	const out: {status: string; filename: string}[] = [];
	for (const line of lines) {
		const parts = line.split("\t");
		const status = parts[0];
		const filename = parts[1];
		if (parts.length !== 2 || status === undefined || filename === undefined) return null;
		if (!FILE_STATUS.has(status)) return null;
		out.push({status, filename});
	}
	return out;
};

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
export const openPullRequests = (exec: Exec, repo: string): Attempt<ReadonlyArray<number>> => {
	const r = exec("gh", [
		"api",
		"--paginate",
		`repos/${repo}/pulls?state=open&per_page=100`,
		"--jq",
		".[].number",
	]);
	if (!r.ok) return fail(r.reason);
	const numbers = parsePrNumbers(r.stdout);
	return numbers === null
		? fail("`gh api` exited 0 but its output is not a list of pull request numbers")
		: ok(numbers);
};

/** The `.decisions/` ids one open pull request ADDS, paged over its file list. */
export const idsClaimedByPr = (
	exec: Exec,
	repo: string,
	pr: number,
	dir: string,
): Attempt<ReadonlyArray<ClaimedId>> => {
	const r = exec("gh", [
		"api",
		"--paginate",
		`repos/${repo}/pulls/${pr}/files?per_page=100`,
		"--jq",
		'.[] | "\\(.status)\t\\(.filename)"',
	]);
	if (!r.ok) return fail(r.reason);
	const rows = parseFileRows(r.stdout);
	if (rows === null) return fail("`gh api` exited 0 but its output is not a list of file rows");
	const claimed: ClaimedId[] = [];
	for (const row of rows) {
		if (row.status !== "added") continue;
		const hit = claimedIdOf(row.filename, dir);
		if (hit !== null) claimed.push({id: hit.id, file: hit.file, pr});
	}
	return ok(claimed);
};
