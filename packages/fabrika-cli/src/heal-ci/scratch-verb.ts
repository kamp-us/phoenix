/**
 * `heal-ci scratch` — the per-lane scratch path a healer writes its note bodies under.
 *
 * `<temp root>/fabrika-heal-ci/<session-id>/<pr>/<slug>`. Two healers running the same sweep derived
 * similar working filenames in one working directory and overwrote each other's note bodies mid-post
 * (#7209/#7210), which is the failure `build scratch` and `triage scratch` already exist to make
 * unconstructible.
 *
 * **The session id is this group's lane nonce, and the PR number is its lane.** The sibling
 * allocators key on a claim nonce because a build or triage fan-out runs many lanes under one
 * session id, so the session alone hands them all one directory. This group has no claim verb and no
 * fan-out: `heal-ci` runs as a forked shell per invocation, so two concurrent healers are two
 * sessions, and within one session the PR under repair is what separates one row of a sweep from the
 * next. Both halves of the key are therefore already in the path, and inventing a nonce for a lane
 * identity that does not exist would key the namespace on a value nothing else in the run can
 * reproduce.
 *
 * The printed path is machine-local and must never reach a posted artifact — `heal-ci note` reds on
 * one (`5`), which is what makes the rule enforced rather than advisory.
 */
import {Effect, FileSystem} from "effect";
import {isKebabSlug} from "../build/lane.ts";
import {sessionIdFrom, sessionIdUnset} from "../io/session-id.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {OFF_VOCABULARY} from "./codes.ts";

const VERB = "heal-ci scratch";

/** A session id fit to be one directory segment — a `/` in it would nest the namespace elsewhere. */
const isPathSegment = (value: string): boolean => /^[A-Za-z0-9._-]+$/.test(value);

/** This lane's namespace, exported so a caller derives the path rather than restating the formula. */
export const laneScratchDir = (tmpRoot: string, session: string, pr: number): string =>
	`${tmpRoot.replace(/\/+$/, "")}/fabrika-heal-ci/${session}/${pr}`;

export interface ScratchOptions {
	readonly pr: number;
	readonly slug: string;
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

		const dir = laneScratchDir(options.tmpRoot, session, pr);
		const fs = yield* FileSystem.FileSystem;
		const failure: string | null = yield* fs.makeDirectory(dir, {recursive: true}).pipe(
			Effect.as(null),
			Effect.catchTag("PlatformError", (cause) => Effect.succeed(cause.message)),
		);
		return failure === null
			? answer(`${dir}/${slug}`)
			: refuse(FAILED, `${VERB}: cannot create ${dir}: ${failure}`);
	});
