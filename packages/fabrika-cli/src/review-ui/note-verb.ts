/**
 * `review-ui note` — the single sanctioned non-verdict write: one plain comment naming a proven
 * blocker state (can't-see, escalation), leak-scanned, read back, and **never a marker**.
 *
 * The typed refusal of marker-shaped bodies is the whole point. v1's plain-note off-ramps were
 * invisible to the ship layer precisely because nothing typed them, and the cure is a typed
 * non-verdict rather than a second marker path: a marker smuggled through here would be a gate
 * emission nobody read back.
 *
 * The note carries **no head**. A blocker note is a dated fact about the PR, not a verdict over a
 * tree — so it is append-only too: a dated fact is never edited in place.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {createComment, getComment} from "../io/issues.ts";
import type {StdinRead} from "../io/stdin.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {readAdvisory} from "../review/advisory.ts";
import {type AuthoredSurface, leakRefusal, readAuthored} from "../review/authored.ts";
import {openPull, resolveTargetRepo} from "../review/target.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {read as readMarker} from "../wire/verdict-marker.ts";
import {OFF_VOCABULARY, PRECONDITION_UNKNOWN, READBACK_MISMATCH, WRITE_UNKNOWN} from "./codes.ts";

const VERB = "review-ui note";

const SURFACE: AuthoredSurface = {
	verb: VERB,
	noun: "the note",
	emptyMessage: `${VERB}: no body on stdin.`,
	bareAtMessage: `${VERB}: the body is a bare "@" path reference — send its bytes on stdin.`,
	leakCorrection: "cite it repo-relative or by class root.",
};

export interface NoteOptions {
	readonly pr: number;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly stdin: Effect.Effect<StdinRead>;
}

/**
 * Whether the body's first non-blank line reaches for a verdict carrier.
 *
 * A `Malformed` marker read counts: bytes reaching for a marker and missing are exactly what a
 * verdict smuggled through this verb would look like, and admitting them would make the refusal
 * depend on getting the marker *right*.
 */
const carriesVerdict = (body: string): boolean =>
	readMarker(body)._tag !== "Absent" || readAdvisory(body) !== null;

export const runNote = (
	options: NoteOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {pr} = options;
		if (!Number.isInteger(pr) || pr <= 0) {
			return refuse(FAILED, `${VERB}: ${pr} is not a pull-request number.`);
		}
		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const target = yield* openPull(VERB, repo, pr, {
			requireOpen: true,
			closedReason: "nothing to note.",
			requireFiles: false,
			unknownMessage: (reason) =>
				`${VERB}: cannot read the PR for #${pr}: ${reason} — nothing was posted.`,
		});
		if (target._tag === "Refused") return target.outcome;

		const authored = readAuthored(SURFACE, yield* options.stdin);
		if (authored._tag === "Refused") return authored.outcome;

		if (carriesVerdict(authored.text)) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: the first line parses as a verdict carrier (marker or advisory line) — a verdict goes through review-ui post, never this verb.`,
			);
		}
		const leaked = leakRefusal(SURFACE, authored.text);
		if (leaked !== null) return leaked;

		const created = yield* createComment(repo, pr, authored.text);
		if (created._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the post failed: ${created.reason} — UNKNOWN whether the note landed; re-read the PR before retrying.`,
			);
		}
		const back = yield* getComment(repo, created.value.id);
		if (back._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the posted note for #${pr}: ${back.reason} — nothing was proven.`,
			);
		}
		if (normalizeForReadback(back.value) !== normalizeForReadback(authored.text)) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: the comment landed but does not read back as sent — inspect comment ${created.value.id}.`,
			);
		}
		return answer(
			JSON.stringify({
				answer: "noted",
				pr,
				commentId: created.value.id,
				commentUrl: created.value.url,
			}),
		);
	});
