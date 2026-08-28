/**
 * `campaign open` — append a new `paused` row pinning a milestone, past the approval trace.
 *
 * **The state is always `paused` and there is no flag to change it.** A row that could be written
 * `active` would grant dispatch in the same stroke that names the campaign, which is exactly what
 * ADR 0304 separated into two acts. Flipping it is `campaign state`'s, and it demands its own
 * citation.
 *
 * Nothing here checks that the milestone exists, is open, or is in sync with the board:
 * `guard roadmap-guard check` owns I1-I5, and a second answer to a merge-gating question is worse
 * than no answer at all (ADR 0238).
 */

import {Effect} from "effect";
import type {CampaignRow} from "../build/scope-admission.ts";
import {writeFile} from "../io/fs.ts";
import {resolveRepo} from "../io/issues.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {CITATION_GRAMMAR, readCitation} from "./citation.ts";
import {AUTHORITY_UNKNOWN, DUPLICATE_ROW, READBACK_MISMATCH, WRITE_UNKNOWN} from "./codes.ts";
import {type CampaignEffect, locateRoadmap, readRoadmap, runTrace} from "./guards.ts";
import {appendRow, nameFitsCell, rowLine} from "./table.ts";

export interface OpenOptions {
	readonly name: string;
	readonly milestone: number;
	readonly cites: string;
	readonly file: string | null;
	readonly repo: string | null;
	readonly json: boolean;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
}

const VERB = "campaign open";
const NOTHING = "NOTHING was written.";

export const runOpen = (options: OpenOptions): CampaignEffect<VerbOutcome> =>
	Effect.gen(function* () {
		const {milestone} = options;
		// Trimmed once, here, so the name the duplicate check compares is the name the row is written
		// with and the name it reads back as — cells arrive trimmed from the parse, so an untrimmed
		// one clears the check and appends a second row nothing can select afterwards.
		const name = options.name.trim();
		if (!Number.isInteger(milestone) || milestone <= 0) {
			return refuse(FAILED, `${VERB}: --milestone must be a positive integer, got "${milestone}".`);
		}
		if (name === "") {
			return refuse(FAILED, `${VERB}: <name> is required.`);
		}
		if (!nameFitsCell(name)) {
			return refuse(
				FAILED,
				`${VERB}: ${name} holds "|" or a newline — a campaign name must fit one table cell.`,
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

		const byName = read.rows.find((row) => row.name === name);
		if (byName !== undefined) {
			return refuse(
				DUPLICATE_ROW,
				`${VERB}: ${display} already holds "${name}" at #${byName.milestone} — ${NOTHING}`,
			);
		}
		const byPin = read.rows.find((row) => row.milestone === milestone);
		if (byPin !== undefined) {
			return refuse(
				DUPLICATE_ROW,
				`${VERB}: ${display} already pins #${milestone} to "${byPin.name}" — ${NOTHING}`,
			);
		}

		const trace = yield* runTrace({
			verb: VERB,
			cwd: options.cwd,
			repo,
			url: citation.url,
			urlRepo: citation.repo,
			commentId: citation.commentId,
			milestone,
			state: "paused",
			act: "declare",
		});
		if (trace._tag === "Refused") return trace.outcome;

		const written = yield* writeFile(path, appendRow(read.text, name, milestone)).pipe(
			Effect.as<VerbOutcome | null>(null),
			Effect.catchTag("fabrika-cli/WriteFailed", (failure) =>
				Effect.succeed<VerbOutcome | null>(
					refuse(
						WRITE_UNKNOWN,
						`${VERB}: cannot write ${display}: ${failure.reason} — UNKNOWN, the table may be half-written; re-read it.`,
					),
				),
			),
		);
		if (written !== null) return written;

		const back = yield* readRoadmap(VERB, located.located, "nothing was written");
		if (back._tag === "Refused") return back.outcome;
		const landed = back.rows.find((row) => row.milestone === milestone);
		if (landed === undefined) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: wrote ${display} but the read-back holds no row for #${milestone} — the write landed and the file does not say so; re-read it before retrying.`,
			);
		}

		const notice = `${VERB}: cited ${citation.url} by @${trace.login} (campaignAuthors: ${trace.declared}; ${trace.level} on ${repo}); appended "${name}" #${milestone} paused to ${display} — dispatches nothing until it is flipped to active.`;
		return answer(rendered(landed, display, options.json), [notice]);
	});

const rendered = (row: CampaignRow, file: string, json: boolean): string =>
	json ? `${JSON.stringify({row, file})}\n` : `${rowLine(row)}\n`;
