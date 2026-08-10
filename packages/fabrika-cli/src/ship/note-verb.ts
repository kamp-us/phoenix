/**
 * `ship note` — the durable stop-path comment.
 *
 * Every non-enqueue path leaves a signal, and this verb is that signal's single sanctioned emitter:
 * a freelanced `gh api -f body=@file` is the #3018 bypass class, and a stop with no signal at all is
 * #1928's silent dead shipper.
 *
 * Stop-path notes are a **history, not a state** — each run's refusal is its own record — so this
 * posts a new comment rather than upserting one. A note on a closed or merged PR is legal for the
 * same reason: refusals happen at every lifecycle stage and the durable record is the point.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {createComment, getComment} from "../io/issues.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {readAuthored, type StdinSource} from "./authored.ts";
import {READBACK_MISMATCH, WRITE_UNKNOWN} from "./codes.ts";
import {badNumber, resolvePull, resolveTargetRepo} from "./target.ts";

const VERB = "ship note";

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
		const {pr, json} = options;
		const bad = badNumber(VERB, "a pull-request number", pr);
		if (bad !== null) return bad;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const authored = readAuthored(VERB, yield* options.stdin, {
			empty: `${VERB}: no body on stdin — a silent stop is the #1928 defect; write the reason.`,
			bareAt: `${VERB}: the body is a bare "@" path reference — the bytes never arrived; pipe them.`,
			leaked: (_count, first) =>
				`${VERB}: the body carries a machine-local path at line ${first.line} (${first.class}) — cite repo-relative (#4994's class routes to a human).`,
		});
		if (authored._tag === "Refused") return authored.outcome;
		const body = authored.text;

		const target = yield* resolvePull(VERB, repo, pr, {
			unknownMessage: (reason) => `${VERB}: cannot read PR #${pr}: ${reason} — nothing was posted.`,
		});
		if (target._tag === "Refused") return target.outcome;

		const diagnostics = [`${VERB}: ${repo}#${pr}, ${authored.bytes} byte(s) read.`];
		const posted = yield* createComment(repo, pr, body);
		if (posted._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: create failed: ${posted.reason} — UNKNOWN whether the note landed; re-read before retrying.`,
				diagnostics,
			);
		}

		const landed = yield* getComment(repo, posted.value.id);
		const matches =
			landed._tag === "Ok" && normalizeForReadback(landed.value) === normalizeForReadback(body);
		if (!matches) {
			return refuse(
				landed._tag === "Failure" ? WRITE_UNKNOWN : READBACK_MISMATCH,
				landed._tag === "Failure"
					? `${VERB}: create failed: the confirming read-back failed: ${landed.reason} — UNKNOWN whether the note landed; re-read before retrying.`
					: `${VERB}: the read-back does not match — inspect comment ${posted.value.id}.`,
				diagnostics,
			);
		}

		return json
			? answer(JSON.stringify({outcome: "noted", commentUrl: posted.value.url}), diagnostics)
			: answer(`noted\t${posted.value.url}`, diagnostics);
	});
