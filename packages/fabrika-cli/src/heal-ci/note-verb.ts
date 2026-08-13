/**
 * `heal-ci note` — the durable stop-path comment.
 *
 * An invisible strand is the whole defect this skill exists to remove, so a lane that stops without
 * a record leaves the next reader with nothing. Each classification is its own record — a strand's
 * history is a history, not a state — so this posts a **new** comment rather than upserting one, and
 * a note on a closed or merged PR is legal: a strand that resolved while the run was classifying it
 * still deserves the record.
 *
 * The leak predicate and the stdin fence are `../ship/authored.ts`'s, imported: this group scans the
 * text a session authored, and scanning *landed* content is `leak-guard.yml`'s enforced seam.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {createComment, getComment} from "../io/issues.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {readAuthored, type StdinSource} from "../ship/authored.ts";
import {badNumber, resolvePull, resolveTargetRepo} from "../ship/target.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {READBACK_MISMATCH, WRITE_UNKNOWN} from "./codes.ts";

const VERB = "heal-ci note";

export interface NoteOptions {
	readonly pr: number;
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

		const diagnostics = [`${VERB}: ${repo}#${pr}, ${authored.bytes} byte(s) read.`];
		const posted = yield* createComment(repo, pr, authored.text);
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
		if (normalizeForReadback(landed.value) !== normalizeForReadback(authored.text)) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: the read-back does not match — inspect comment ${posted.value.id}.`,
				diagnostics,
			);
		}

		return options.json
			? answer(JSON.stringify({outcome: "noted", commentUrl: posted.value.url}), diagnostics)
			: answer(`noted\t${posted.value.url}`, diagnostics);
	});
