/**
 * `triage scratch` — the per-lane scratch path a triager writes its working files under.
 *
 * `<temp root>/fabrika-triage/<session-id>/<issue>-<claim-nonce>/<slug>`. A fan-out of triagers runs
 * under one session id, so a namespace keyed on the session alone hands every lane the same
 * directory and a fixed name like `authored.md` clobbers a sibling's file silently — which happened
 * on 2026-08-20 across #6597/#6189/#6146, and was caught only because the overwritten content
 * happened to be a different issue's body (#6630). The claim nonce in the key makes that
 * unconstructible rather than detectable, exactly as `build scratch` does for build lanes (#6037).
 *
 * The printed path is machine-local and must never reach a posted artifact — the leak predicate the
 * writing verbs share reds on the temp roots it lives under.
 */
import {Effect, FileSystem} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {isKebabSlug} from "../build/lane.ts";
import {listComments, resolveRepo} from "../io/issues.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {
	DEFAULT_TTL_MINUTES,
	markersOf,
	requireCallerToken,
	requireSession,
	resolveClaim,
} from "./claim.ts";
import {CLAIM_NOT_HELD, OFF_VOCABULARY, PRECONDITION_UNKNOWN} from "./codes.ts";
import {scannedLine} from "./scope.ts";

const VERB = "triage scratch";

/** A session id fit to be one directory segment — a `/` in it would nest the namespace elsewhere. */
const isPathSegment = (value: string): boolean => /^[A-Za-z0-9._-]+$/.test(value);

/** This lane's namespace, exported so a caller derives the path rather than restating the formula. */
export const laneScratchDir = (
	tmpRoot: string,
	session: string,
	issue: number,
	nonce: string,
): string => `${tmpRoot.replace(/\/+$/, "")}/fabrika-triage/${session}/${issue}-${nonce}`;

export interface ScratchOptions {
	readonly issue: number;
	readonly slug: string;
	/** The token `triage claim` handed this lane — what keys the namespace per lane, not per session. */
	readonly token: string;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** The OS temp root, read by the adapter — the one machine fact this verb does not derive. */
	readonly tmpRoot: string;
	readonly now: () => Date;
}

export const runScratch = (
	options: ScratchOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const {issue, slug} = options;

		if (!Number.isInteger(issue) || issue <= 0) {
			return refuse(FAILED, `${VERB}: ${issue} is not an issue number.`);
		}
		if (slug.includes("/") || slug.includes("\\") || !isKebabSlug(slug)) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --slug "${slug}" must be a kebab-case leaf, no path separators.`,
			);
		}

		const stamped = requireSession(
			VERB,
			options.env,
			"refusing to key a scratch namespace on an unattributable session",
		);
		if ("refusal" in stamped) return stamped.refusal;
		const session = stamped.value;
		if (!isPathSegment(session)) {
			return refuse(
				FAILED,
				`${VERB}: CLAUDE_CODE_SESSION_ID is not one path segment — it cannot name a directory of its own.`,
			);
		}

		const asking = requireCallerToken(VERB, session, options.token);
		if ("refusal" in asking) return asking.refusal;
		const {caller} = asking.value;

		const repoAttempt = yield* resolveRepo(options.repo, options.env);
		if (repoAttempt._tag === "Failure") {
			return refuse(
				FAILED,
				`${VERB}: cannot resolve a target repo — set CLAUDE_PIPELINE_REPO, or run inside a checkout whose origin remote resolves.`,
			);
		}
		const repo = repoAttempt.value;

		const comments = yield* listComments(repo, issue);
		if (comments._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read #${issue}'s comments in ${repo}: ${comments.reason} — the claim on it is UNKNOWN, so no path was allocated.`,
			);
		}
		const scope = scannedLine(VERB, repo, comments.value.length, "comment");

		const resolution = resolveClaim({
			markers: markersOf(comments.value),
			caller,
			now: options.now().getTime(),
			ttlMinutes: DEFAULT_TTL_MINUTES,
		});
		if (resolution._tag === "Unresolvable") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot resolve the claim on #${issue} in ${repo}: ${resolution.reason} — no path was allocated.`,
				[scope],
			);
		}
		if (resolution._tag === "MineAbsent") {
			return refuse(
				CLAIM_NOT_HELD,
				`${VERB}: this lane holds no live claim on #${issue} — run \`fabrika triage claim ${issue}\` and act only on \`won\`.`,
				[scope],
			);
		}
		if (resolution._tag === "Lost") {
			return refuse(
				CLAIM_NOT_HELD,
				`${VERB}: #${issue} is held by the lane on nonce ${resolution.holder.lane ?? "(unstated)"}, not by this one — back off.`,
				[scope],
			);
		}

		const dir = laneScratchDir(options.tmpRoot, session, issue, caller.nonce);
		const fs = yield* FileSystem.FileSystem;
		const failure: string | null = yield* fs.makeDirectory(dir, {recursive: true}).pipe(
			Effect.as(null),
			Effect.catchTag("PlatformError", (cause) => Effect.succeed(cause.message)),
		);
		return failure === null
			? answer(`${dir}/${slug}`, [scope])
			: refuse(FAILED, `${VERB}: cannot create ${dir}: ${failure}`, [scope]);
	});
