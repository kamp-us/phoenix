/**
 * `campaign state` — rewrite one row's `State` cell, past the approval trace.
 *
 * Selection is exact, never fuzzy, and **two rows matching is `18` rather than a first-wins pick**: a
 * lifecycle flip aimed at the wrong campaign grants dispatch on a milestone nobody named.
 *
 * **`20` is a refusal and not a quiet `0`.** A flip to `active` is the grant of dispatch permission,
 * so a caller who reads "done" over a cell nobody moved cannot tell a grant they made from a grant
 * somebody else made first.
 *
 * Whether the milestone should be closed alongside a flip to `done` is `roadmap-guard`'s I5 and is
 * not repeated here (ADR 0238).
 */

import {Effect} from "effect";
import {CAMPAIGN_STATES, type CampaignState} from "../build/scope-admission.ts";
import {writeFile} from "../io/fs.ts";
import {resolveRepo} from "../io/issues.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {CITATION_GRAMMAR, readCitation} from "./citation.ts";
import {
	ALREADY_IN_STATE,
	AMBIGUOUS_SELECTOR,
	AUTHORITY_UNKNOWN,
	NO_TARGET,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {type CampaignEffect, locateRoadmap, readRoadmap, runTrace} from "./guards.ts";
import {placedRows, rewriteState, rowLine, selects} from "./table.ts";

export interface StateOptions {
	readonly selector: string;
	readonly to: string;
	readonly cites: string;
	readonly file: string | null;
	readonly repo: string | null;
	readonly json: boolean;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
}

const VERB = "campaign state";
const NOTHING = "NOTHING was written.";

export const runState = (options: StateOptions): CampaignEffect<VerbOutcome> =>
	Effect.gen(function* () {
		const to = CAMPAIGN_STATES.find((legal) => legal === options.to);
		if (to === undefined) {
			return refuse(
				FAILED,
				`${VERB}: --to "${options.to}" is not one of ${CAMPAIGN_STATES.join(", ")}.`,
			);
		}

		const resolved = yield* resolveRepo(options.repo, options.env);
		if (resolved._tag === "Failure") {
			return refuse(
				AUTHORITY_UNKNOWN,
				`${VERB}: no --repo, no CLAUDE_PIPELINE_REPO, no GITHUB_REPOSITORY and no readable origin remote — the citation cannot be bound to a repository. ${NOTHING}`,
			);
		}
		const repo = resolved.value;

		const citation = readCitation(options.cites);
		if (citation === null) {
			return refuse(
				FAILED,
				`${VERB}: --cites "${options.cites}" is not a comment URL in ${repo} — expected ${CITATION_GRAMMAR}.`,
			);
		}

		const located = yield* locateRoadmap(VERB, options.cwd, options.file);
		if (located._tag === "Refused") return located.outcome;
		const {display, path} = located.located;

		const read = yield* readRoadmap(VERB, located.located, "nothing was written");
		if (read._tag === "Refused") return read.outcome;

		const placed = placedRows(read.text);
		// `readRoadmap` already refused the `Malformed` arm, so this only narrows the union.
		const matched = (placed._tag === "Rows" ? placed.rows : []).filter((row) =>
			selects(row, options.selector),
		);
		const target = matched[0];
		if (target === undefined) {
			return refuse(
				NO_TARGET,
				`${VERB}: ${display} has no campaign row matching "${options.selector}" — ${NOTHING}`,
			);
		}
		if (matched.length > 1) {
			const names = matched.map((row) => `"${row.row.name}"`).join(", ");
			return refuse(
				AMBIGUOUS_SELECTOR,
				`${VERB}: "${options.selector}" matches ${matched.length} rows (${names}) — ${NOTHING}`,
			);
		}
		const from: CampaignState = target.row.state;
		if (from === to) {
			return refuse(
				ALREADY_IN_STATE,
				`${VERB}: "${target.row.name}" #${target.row.milestone} already holds ${to} — ${NOTHING}`,
			);
		}

		const trace = yield* runTrace({
			verb: VERB,
			cwd: options.cwd,
			repo,
			url: citation.url,
			urlRepo: citation.repo,
			commentId: citation.commentId,
			milestone: target.row.milestone,
			state: to,
			act: "flip",
		});
		if (trace._tag === "Refused") return trace.outcome;

		const next = rewriteState(read.text, target.line, to);
		if (next === null) {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: cannot write ${display}: row ${target.line + 1} does not carry three cells between four pipes — UNKNOWN, the row may be half-written; re-read it.`,
			);
		}
		const written = yield* writeFile(path, next).pipe(
			Effect.as<VerbOutcome | null>(null),
			Effect.catchTag("fabrika-cli/WriteFailed", (failure) =>
				Effect.succeed<VerbOutcome | null>(
					refuse(
						WRITE_UNKNOWN,
						`${VERB}: cannot write ${display}: ${failure.reason} — UNKNOWN, the row may be half-written; re-read it.`,
					),
				),
			),
		);
		if (written !== null) return written;

		const back = yield* readRoadmap(VERB, located.located, "nothing was written");
		if (back._tag === "Refused") return back.outcome;
		const landed = back.rows.find((row) => row.milestone === target.row.milestone);
		if (landed === undefined || landed.state !== to) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: wrote ${display} but the read-back holds ${landed?.state ?? "no row"} for #${target.row.milestone}, not ${to} — the write landed and the file does not say so; re-read it before retrying.`,
			);
		}

		const grant = to === "active" ? ` — lanes may now open against #${landed.milestone}.` : "";
		const notice = `${VERB}: cited ${citation.url} by @${trace.login} (campaignAuthors: ${trace.declared}; ${trace.level} on ${repo}); "${landed.name}" #${landed.milestone} ${from} → ${to} in ${display}.${grant}`;
		return answer(
			options.json
				? `${JSON.stringify({row: landed, from, file: display})}\n`
				: `${rowLine(landed)}\n`,
			[notice],
		);
	});
