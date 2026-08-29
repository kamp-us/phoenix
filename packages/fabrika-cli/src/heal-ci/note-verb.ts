/**
 * `heal-ci note` — the durable stop-path comment, suppressed per `<pr>:<class>:<head>`.
 *
 * An invisible strand is the whole defect this skill exists to remove, so a lane that stops without
 * a record leaves the next reader with nothing. Each classification is its own record — a strand's
 * history is a history, not a state — so this posts a **new** comment rather than upserting one, and
 * a note on a closed or merged PR is legal: a strand that resolved while the run was classifying it
 * still deserves the record.
 *
 * What is *not* its own record is the same classification of the same head by a second caller.
 * Before creating, this reads the pull request's whole comment history and refuses `14` on a comment
 * already carrying the key — the suppression that used to live in `heal-ci-sweep.yml`'s `run:` block,
 * moved into the verb so every note path inherits it and the workflow relays a decision instead of
 * deriving one (ADR 0228, #7209). The key's format and its reader live in `note-key.ts`.
 *
 * The leak predicate and the stdin fence are `../ship/authored.ts`'s, imported: this group scans the
 * text a session authored, and scanning *landed* content is `leak-guard.yml`'s enforced seam.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {createComment, getComment, listComments} from "../io/issues.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {readAuthored, type StdinSource} from "../ship/authored.ts";
import {badNumber, resolvePull, resolveTargetRepo} from "../ship/target.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {
	INCOMPLETE_SCAN,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	PROVEN_NOT_IN_STATE,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {keyBoundTo, keyOf, renderKey, withKey} from "./note-key.ts";
import {isStallToken, STALL_TOKENS} from "./stall.ts";

const VERB = "heal-ci note";

/**
 * The key's head is a **full** 40-hex sha, not the 7-40 the read verbs prefix-match.
 *
 * A key is an identity, and an identity built from an abbreviation cannot be compared for equality:
 * the incident that produced this verb's suppression also produced two notes on one PR citing
 * `6d8fc285…` and `6d8fc283…`, a hand-typed prefix diverging in its fifth digit. Demanding the whole
 * sha is what takes the transcription out of the note's identity line.
 */
const FULL_SHA = /^[0-9a-f]{40}$/;

export interface NoteOptions {
	readonly pr: number;
	/** The stall class this note records — one of `stall.ts`'s tokens, the key's middle field. */
	readonly stallClass: string;
	/** The head the classification was taken at, as a full 40-hex sha. */
	readonly sha: string;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly stdin: StdinSource;
}

export const runNote = (
	options: NoteOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const bad = badNumber(VERB, "a pull-request number", options.pr);
		if (bad !== null) return bad;

		if (!isStallToken(options.stallClass)) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --class ${options.stallClass === "" ? "(empty)" : options.stallClass} is not a stall class (known: ${STALL_TOKENS.join(", ")}).`,
			);
		}
		if (!FULL_SHA.test(options.sha)) {
			return refuse(
				FAILED,
				`${VERB}: --sha must be the full 40-hex head this classification was taken at, not "${options.sha}" — a suppression key built from an abbreviation cannot be compared for equality.`,
			);
		}

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;
		const pr = options.pr;

		const authored = readAuthored(VERB, yield* options.stdin, {
			empty: `${VERB}: no body on stdin — a silent classification leaves the strand as invisible as it was found; write the reason.`,
			bareAt: `${VERB}: the body is a bare "@" path reference — the bytes never arrived. Send them on stdin.`,
			leaked: (_count, first) =>
				`${VERB}: the body carries a machine-local path at line ${first.line} (${first.class}) — cite it repo-relative.`,
		});
		if (authored._tag === "Refused") return authored.outcome;

		const target = yield* resolvePull(VERB, repo, pr, {
			unknownMessage: (reason) => `${VERB}: cannot read PR #${pr}: ${reason} — nothing was posted.`,
		});
		if (target._tag === "Refused") return target.outcome;
		const pull = target.pull;

		const key = keyOf(pr, options.stallClass, options.sha);
		const diagnostics = [
			`${VERB}: ${repo}#${pr}, ${authored.bytes} byte(s) read; key ${renderKey(key)}.`,
		];
		if (pull.headSha !== options.sha) {
			// A notice, never a refusal: the note is the record of a classification taken at a head, and
			// a head that moved under it does not make the record false. Refusing here would lose the
			// only trace of a strand somebody just diagnosed.
			diagnostics.push(
				`${VERB}: the live head is ${pull.headSha}, this note is keyed to ${options.sha} — recording the classification at the head it was taken at.`,
			);
		}

		const commented = yield* listComments(repo, pr);
		if (commented._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read #${pr}'s comments: ${commented.reason} — suppression state is UNKNOWN, so nothing was posted.`,
				diagnostics,
			);
		}
		if (commented.value.length < pull.comments) {
			return refuse(
				INCOMPLETE_SCAN,
				`${VERB}: received ${commented.value.length} of ${pull.comments} declared comments — refusing to post over a truncated suppression read.`,
				diagnostics,
			);
		}
		const already = keyBoundTo(commented.value, key);
		if (already !== null) {
			return refuse(
				PROVEN_NOT_IN_STATE,
				`${VERB}: #${pr} already carries a note at key ${pr}:${options.stallClass}:${options.sha} (comment ${already.id}) — this strand is recorded; nothing was posted.`,
				diagnostics,
			);
		}

		const body = withKey(authored.text, key);
		const posted = yield* createComment(repo, pr, body);
		if (posted._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: create failed: ${posted.reason} — UNKNOWN whether the note landed; re-read before retrying.`,
				diagnostics,
			);
		}

		const landed = yield* getComment(repo, posted.value.id);
		if (landed._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: create failed: the confirming read-back failed: ${landed.reason} — UNKNOWN whether the note landed; re-read before retrying.`,
				diagnostics,
			);
		}
		if (normalizeForReadback(landed.value) !== normalizeForReadback(body)) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: the read-back does not match — inspect comment ${posted.value.id}.`,
				diagnostics,
			);
		}

		return options.json
			? answer(
					JSON.stringify({
						outcome: "noted",
						commentUrl: posted.value.url,
						key: `${pr}:${options.stallClass}:${options.sha}`,
					}),
					diagnostics,
				)
			: answer(`noted\t${posted.value.url}`, diagnostics);
	});
