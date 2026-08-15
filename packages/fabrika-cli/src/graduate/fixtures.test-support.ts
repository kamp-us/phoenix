/**
 * The sources, trails and spec bodies the `graduate` verb tests are driven from.
 *
 * They compose the same bytes the group actually reads and writes — a session through the `grill`
 * fixtures, a map body through the `map` ones, a spec through `./spec.ts` — so a test asserts against
 * what the verbs produce rather than against a transcription of it.
 */

import {
	AUTHORIZATION,
	answerComment,
	commentsPayload,
	type FakeComment,
	roundComment,
	roundDigestOf,
	rulingComment,
} from "../grill/fixtures.test-support.ts";
import {composeSpec} from "./spec.ts";
import type {DecisionRow} from "./trail.ts";

export const REPO = "o/r";
export const SESSION = 9412;
export const MAP = 9140;

/** The digest the fixture session's round 1 binds. */
export const BOUND = roundDigestOf(1);

/** Round 1 as the session carries it: one fact question, one decision question. */
export const ROUND: FakeComment = {id: 1, author: "acme-founder", body: roundComment(1)};

/** A session with the fact answered and the decision ruled — the trail reads `ready`. */
export const CLEARED_SESSION: ReadonlyArray<FakeComment> = [
	ROUND,
	{id: 2, author: "acme-founder", body: answerComment("R1.1", BOUND)},
	{id: 3, author: "acme-founder", body: AUTHORIZATION},
	{id: 4, author: "acme-founder", body: rulingComment("R1.2", BOUND)},
];

/** The two decisions a cleared fixture session normalizes into, in trail order. */
export const CLEARED_DECISIONS: ReadonlyArray<DecisionRow> = [
	{
		ref: "R1.1",
		provenance: "established",
		text: "Does the vote table already carry a per-account weight column?",
	},
	{
		ref: "R1.2",
		provenance: "ruled",
		text: "Do vouched-in yazars inherit their kefil's moderation weight?",
	},
];

export {commentsPayload};

export const issueJson = (input: {
	readonly number: number;
	readonly title?: string;
	readonly body?: string;
	readonly labels?: ReadonlyArray<string>;
}): string =>
	JSON.stringify({
		number: input.number,
		title: input.title ?? `issue ${input.number}`,
		body: input.body ?? "",
		state: "open",
		labels: (input.labels ?? []).map((name) => ({name})),
		html_url: `https://github.com/${REPO}/issues/${input.number}`,
		user: {login: "acme-founder"},
		milestone: null,
		state_reason: null,
	});

/** A map body carrying one relayed ruling, one research finding, and one retired direction. */
export const MAP_BODY = [
	"## Destination",
	"how moderation weight is earned",
	"",
	"## Decisions",
	"- Weight is earned per account, never inherited from a kefil. — ruled on #9301 R1.2",
	"- The vote table has no per-account weight column today. — from #9505",
	"",
	"## Frontier",
	"- #9142 · research — which table carries the per-account weight column?",
	"",
	"## Fog",
	"- what clock does weight decay on?",
	"",
	"## Out of scope",
	"- a per-topic weight multiplier. It makes every action's authority unreadable — 2026-06-29",
	"",
].join("\n");

/** The three authored sections a caller pipes to `graduate compose`. */
export const AUTHORED = [
	"## Problem",
	"Moderation weight is unbounded, so one vouched account can outvote a whole topic.",
	"",
	"## Solution",
	"Weight is earned per account and capped per topic; the vote table carries the cap.",
	"",
	"## Out of scope",
	"Weight decay on a clock — no decision yet.",
	"",
].join("\n");

/** The composed spec body for a set of decisions — what `graduate emit --spec` is handed. */
export const specFor = (decisions: ReadonlyArray<DecisionRow>): string =>
	composeSpec(AUTHORED, decisions);
