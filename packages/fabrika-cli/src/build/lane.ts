/**
 * Lane identity: **the branch name is the record.**
 *
 * A lane branch's name carries the lane — `build/<number>-<slug>-<nonce>` in create mode,
 * `build/pr-<pr>-<nonce>` in resume mode — where the nonce is the first 8 hex of the current claim
 * token's UUID. A verb proving "this is my lane" parses the number and the nonce back out of the
 * checked-out branch, re-reads that number's claim, and requires this session to hold it under a token
 * whose UUID begins with the nonce.
 *
 * **There is no stamp file, and that absence is the design.** The stamp machinery is the accretion the
 * 2026-08-03 amendment on #4707 measured; worse, one stamp came to name eight trees at once (#4500).
 * A per-claim nonce in the branch name makes a duplicate lane unconstructible rather than detectable,
 * and leaves nothing to go stale.
 */

/** The claim token shape, pinned: `build:<session-id>:<uuid>` (#4428). */
export const TOKEN_PREFIX = "build";

/** A UUID's first 8 hex characters — the nonce every lane branch carries. */
export const NONCE_LENGTH = 8;

const TOKEN_RES = new Map<string, RegExp>();

// Derived from the prefix rather than typed beside it, so a second claim namespace (`lane:`, #5761)
// cannot ship a token writer and a token reader that disagree.
const tokenRe = (prefix: string): RegExp => {
	const cached = TOKEN_RES.get(prefix);
	if (cached !== undefined) return cached;
	const compiled = new RegExp(`^${prefix}:([^:\\s]+):([0-9a-f-]{8,})$`);
	TOKEN_RES.set(prefix, compiled);
	return compiled;
};

/** The `<session-id>` and `<uuid>` halves of a token, or `null` when it does not carry `prefix`. */
export const parseToken = (
	token: string,
	prefix: string = TOKEN_PREFIX,
): {readonly session: string; readonly uuid: string} | null => {
	const m = tokenRe(prefix).exec(token.trim());
	return m?.[1] === undefined || m[2] === undefined ? null : {session: m[1], uuid: m[2]};
};

/** The lane nonce a token confers, or `null` when the token does not parse. */
export const nonceOf = (token: string, prefix: string = TOKEN_PREFIX): string | null => {
	const parsed = parseToken(token, prefix);
	if (parsed === null) return null;
	const hex = parsed.uuid.replace(/-/g, "").slice(0, NONCE_LENGTH);
	return hex.length === NONCE_LENGTH ? hex : null;
};

/** Compose a token from this session's id and a fresh UUID. */
export const composeToken = (
	session: string,
	uuid: string,
	prefix: string = TOKEN_PREFIX,
): string => `${prefix}:${session}:${uuid}`;

/**
 * A slug the branch name may carry: kebab-case, ≤5 words, never flag-shaped.
 *
 * The leading-hyphen refusal is not stylistic — a slug that begins with `-` is read by the next tool
 * in the chain as a flag, which is how `--slug -rf` becomes an argument to something else (#4854).
 */
export const isKebabSlug = (slug: string): boolean =>
	/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.split("-").length <= 5;

export type LaneBranch =
	| {
			readonly _tag: "Create";
			readonly number: number;
			readonly slug: string;
			readonly nonce: string;
	  }
	| {readonly _tag: "Resume"; readonly pr: number; readonly nonce: string};

const CREATE_RE = /^build\/(\d+)-([a-z0-9]+(?:-[a-z0-9]+)*)-([0-9a-f]{8})$/;
const RESUME_RE = /^build\/pr-(\d+)-([0-9a-f]{8})$/;

/** Parse a checked-out branch name back into its lane, or `null` when it is not a lane branch. */
export const parseLaneBranch = (name: string): LaneBranch | null => {
	const resume = RESUME_RE.exec(name);
	if (resume?.[1] !== undefined && resume[2] !== undefined) {
		return {_tag: "Resume", pr: Number.parseInt(resume[1], 10), nonce: resume[2]};
	}
	const create = CREATE_RE.exec(name);
	if (create?.[1] !== undefined && create[2] !== undefined && create[3] !== undefined) {
		return {
			_tag: "Create",
			number: Number.parseInt(create[1], 10),
			slug: create[2],
			nonce: create[3],
		};
	}
	return null;
};

/** The number a lane branch is claimed under — the issue in create mode, the PR in resume mode. */
export const laneNumber = (lane: LaneBranch): number =>
	lane._tag === "Create" ? lane.number : lane.pr;

export const createBranchName = (number: number, slug: string, nonce: string): string =>
	`build/${number}-${slug}-${nonce}`;

export const resumeBranchName = (pr: number, nonce: string): string => `build/pr-${pr}-${nonce}`;
