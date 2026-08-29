/**
 * `review scratch` — the per-lane scratch path a reviewer stages verb output under.
 *
 * `<temp root>/fabrika-review/<session-id>/<pr>-<lane-nonce>/<slug>`, the shape `build scratch` and
 * `triage scratch` already print. The review lane was the one staging lane that never got it: a
 * reviewer whose diff exceeded one read picked a generic filename in the session scratchpad, a
 * concurrent lane writing the same name replaced the bytes between two offset reads, and the verdict
 * graded one PR's criteria against another PR's diff while carrying the correct head — which nothing
 * downstream, `ship`'s re-derivation included, can detect (#7246, live on PR #7232).
 *
 * **The nonce is derived, because this group has no claim to take it from.** `build scratch` and
 * `triage scratch` key on the nonce of a claim token their lane holds; `review` ships no claim verb,
 * so there is no token to copy that derivation from. The key is instead the two facts a review lane
 * already carries and a second lane cannot both repeat:
 *
 *  - **`--lane`**, the lane key out of the spawn brief. Two reviewers running at once are two lanes,
 *    so this is what separates two lanes of one session — the axis the incident turned on.
 *  - **`--sha`**, the head `review scope` bound and every later verb is passed. Two review rounds of
 *    one lane are two reviews of two trees, and without the head in the key round 2 reads round 1's
 *    staged diff under the same slug — the same wrong-tree read, one round later.
 *
 * Both are required: a default for either would hand back a path shared with whatever the missing
 * axis was supposed to separate, which is the failure this verb exists to make unconstructible. When
 * no lane can be named the verb refuses (`1`) rather than degrading to a session-wide directory.
 *
 * The printed path is machine-local. `review post` and `review append-criterion` red on it through
 * the shared `report/leaks.ts` predicate (`5`), the same refusal `build pr` and `build note` make.
 */
import {createHash} from "node:crypto";
import {Effect, FileSystem} from "effect";
import {isKebabSlug} from "../build/lane.ts";
import {sessionIdFrom, sessionIdUnset} from "../io/session-id.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {OFF_VOCABULARY} from "./codes.ts";

const VERB = "review scratch";

/** A session id fit to be one directory segment — a `/` in it would nest the namespace elsewhere. */
const isPathSegment = (value: string): boolean => /^[A-Za-z0-9._-]+$/.test(value);

/** The shape every `review` verb's `--sha` takes, checked here without a network read. */
const isHeadSha = (value: string): boolean => /^[0-9a-f]{7,40}$/.test(value);

/**
 * The lane's nonce: twelve hex of `sha256(lane \n sha)`.
 *
 * Hashed rather than interpolated because a lane key is free-form — `chore:<name>` carries a colon,
 * and a key with a separator in it would nest the namespace somewhere nobody named. Deterministic
 * because every call in one lane must resolve to the one directory: a random nonce would hand the
 * same lane a new directory per call, which is a leak, not a separation.
 */
export const laneNonce = (lane: string, sha: string): string =>
	createHash("sha256").update(`${lane}\n${sha}`).digest("hex").slice(0, 12);

/** This lane's namespace, exported so a caller derives the path rather than restating the formula. */
export const laneScratchDir = (
	tmpRoot: string,
	session: string,
	pr: number,
	nonce: string,
): string => `${tmpRoot.replace(/\/+$/, "")}/fabrika-review/${session}/${pr}-${nonce}`;

export interface ScratchOptions {
	readonly pr: number;
	readonly slug: string;
	/** The lane key out of the spawn brief — what tells two reviewers of ONE session apart. */
	readonly lane: string;
	/** The head `review scope` bound — what tells two rounds of ONE lane apart. */
	readonly sha: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** The OS temp root, read by the adapter — the one machine fact this verb does not derive. */
	readonly tmpRoot: string;
}

export const runScratch = (
	options: ScratchOptions,
): Effect.Effect<VerbOutcome, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const {pr, slug} = options;

		if (!Number.isInteger(pr) || pr <= 0) {
			return refuse(FAILED, `${VERB}: ${pr} is not a pull-request number.`);
		}
		if (slug.includes("/") || slug.includes("\\") || !isKebabSlug(slug)) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --slug "${slug}" must be a kebab-case leaf, no path separators.`,
			);
		}

		const lane = options.lane.trim();
		if (lane === "") {
			return refuse(
				FAILED,
				`${VERB}: --lane is blank — this run names no lane, so the only namespace left is the session's, which is the one two reviewers share; refusing to allocate it.`,
			);
		}

		const sha = options.sha.trim().toLowerCase();
		if (!isHeadSha(sha)) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --sha "${options.sha}" is not a head SHA — expected 7–40 hex characters.`,
			);
		}

		const session = sessionIdFrom(options.env);
		if (session === null) {
			return refuse(
				FAILED,
				`${VERB}: ${sessionIdUnset} — refusing to key a scratch namespace on an unattributable session.`,
			);
		}
		if (!isPathSegment(session)) {
			return refuse(
				FAILED,
				`${VERB}: the session id is not one path segment — it cannot name a directory of its own.`,
			);
		}

		const dir = laneScratchDir(options.tmpRoot, session, pr, laneNonce(lane, sha));
		const fs = yield* FileSystem.FileSystem;
		const failure: string | null = yield* fs.makeDirectory(dir, {recursive: true}).pipe(
			Effect.as(null),
			Effect.catchTag("PlatformError", (cause) => Effect.succeed(cause.message)),
		);
		return failure === null
			? answer(`${dir}/${slug}`)
			: refuse(FAILED, `${VERB}: cannot create ${dir}: ${failure}`);
	});
