/**
 * `lane scratch` — the driver's per-lane scratch path, allocated fail-closed.
 *
 * `build scratch` gave every builder a claim-nonce-keyed directory, and the driver above it had
 * nothing: an operator that wrote a helper — a wrapper that `cd`s into one worktree and runs fabrika
 * there — wrote it into the session scratchpad, which every lane of the session shares, so a sibling
 * operator rewrote it and the builders calling it ran their verbs in that sibling's tree. This is the
 * same namespace one level up, keyed on the nonce of the `lane claim` token the CALLER holds — never
 * the winning marker's, which an adopt leaves naming a dead seat.
 *
 * A `chore:<name>` lane holds no claim, so it has no nonce to key on and is refused rather than
 * handed a session-wide path — a namespace two drivers can share is the defect this verb removes.
 *
 * The printed path is machine-local and must never reach a posted artifact: every posting verb's
 * leak scan reds on the temp root it sits under (`report/leaks.ts`).
 */
import {Effect, FileSystem} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {requireCallerToken, requireSession, resolveOwnership} from "../build/claim.ts";
import {isKebabSlug} from "../build/lane.ts";
import {resolveTargetRepo} from "../build/target.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {claimTarget, LANE_CLAIM} from "./claim.ts";
import {CLAIM_NOT_MINE, LANE_UNREADABLE, SLUG_OFF_VOCABULARY} from "./codes.ts";
import type {LaneKey} from "./key.ts";

const VERB = "lane scratch";

/** The driver's namespace — a fixed segment apart from `fabrika-build`, so a lane and its builder never share one. */
export const laneScratchDir = (
	tmpRoot: string,
	session: string,
	number: number,
	nonce: string,
): string => `${tmpRoot.replace(/\/+$/, "")}/fabrika-lane/${session}/${number}-${nonce}`;

export interface LaneScratchOptions {
	readonly key: LaneKey;
	readonly lane: string;
	readonly slug: string;
	/** The token `lane claim` handed this driver — what keys the namespace per lane. */
	readonly token: string;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** The OS temp root, read by the adapter — the one machine fact this verb does not derive. */
	readonly tmpRoot: string;
}

export const runLaneScratch = (
	options: LaneScratchOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const {slug} = options;
		if (slug.includes("/") || slug.includes("\\") || !isKebabSlug(slug)) {
			return refuse(
				SLUG_OFF_VOCABULARY,
				`${VERB}: --slug "${slug}" must be a kebab-case leaf, no path separators.`,
			);
		}
		const session = requireSession(VERB, options.env);
		if (session._tag === "Refused") return session.outcome;

		const target = claimTarget(options.key);
		if (target._tag === "Inert") {
			return refuse(
				FAILED,
				`${VERB}: ${target.why}, so no lane-claim nonce exists to key a scratch namespace on — a chore driver writes no lane-local helper.`,
			);
		}

		const asking = requireCallerToken(VERB, session.id, options.token, LANE_CLAIM);
		if (asking._tag === "Refused") return asking.outcome;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;

		const {ownership} = yield* resolveOwnership(
			resolved.repo,
			target.number,
			asking.caller,
			LANE_CLAIM,
		);
		if (ownership._tag === "Unknown") {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot read the lane-claim markers on #${target.number}: ${ownership.reason} — ownership is UNKNOWN, never "held".`,
			);
		}
		if (ownership._tag !== "Mine") {
			return refuse(
				CLAIM_NOT_MINE,
				ownership._tag === "Foreign"
					? `${VERB}: #${target.number} is held by ${ownership.marker.token}, not by this token — no lane, no namespace.`
					: `${VERB}: no live lane claim of this token stands on #${target.number} — run "fabrika lane claim ${options.lane}" first.`,
			);
		}

		const dir = laneScratchDir(options.tmpRoot, session.id, target.number, asking.caller.nonce);
		const fs = yield* FileSystem.FileSystem;
		const made: string | null = yield* fs.makeDirectory(dir, {recursive: true}).pipe(
			Effect.as(null),
			Effect.catchTag("PlatformError", (cause) => Effect.succeed(cause.message)),
		);
		return made === null
			? answer(`${dir}/${slug}`)
			: refuse(FAILED, `${VERB}: cannot create ${dir}: ${made}`);
	});
