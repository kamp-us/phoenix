/**
 * The session fixtures the `grill` verb tests are driven from.
 *
 * They compose the same bytes the verbs write — a round comment through
 * {@link composeRoundComment}, the markers through their own schema modules — so a test asserts
 * against what the group actually posts rather than against a transcription of it. A hand-typed
 * fixture drifts from the writer the first time either moves, and the drift reads as a passing test.
 */

import * as grillAnswer from "../wire/grill-answer.ts";
import {questionId, roundDigest, stampOf} from "../wire/grill-marker.ts";
import * as grillRuling from "../wire/grill-ruling.ts";
import * as grillSupersede from "../wire/grill-supersede.ts";
import {addressBlocks, composeRoundComment, digestRound, parseQuestionBlocks} from "./round.ts";

export const AT = stampOf(new Date("2026-08-09T18:36:48.000Z")) ?? never("the fixture stamp");

function never(what: string): never {
	throw new Error(`${what} did not build — the fixture is broken, not the code under test`);
}

/** A round body in the grammar `grill round` reads off stdin: one fact, one decision. */
export const ROUND_BODY = [
	"### 1 · fact",
	"Does the vote table already carry a per-account weight column?",
	"",
	"**Recommended:** Check the vote feature's schema before designing one.",
	"",
	"### 2 · decision",
	"Do vouched-in yazars inherit their kefil's moderation weight?",
	"",
	"**Recommended:** No — weight is earned per account.",
	"",
	"**Trade-offs:** Slower trust accrual; simpler abuse story.",
	"",
].join("\n");

/** The same round as the comment the verb posts, stamped for `round`. */
export const roundComment = (round: number, body = ROUND_BODY): string => {
	const parsed = parseQuestionBlocks(body);
	if (parsed._tag !== "Blocks") never(`the fixture round body (${parsed.reason})`);
	const questions = addressBlocks(round, parsed.blocks) ?? never("the fixture round addresses");
	return composeRoundComment(round, questions);
};

/** The digest the verbs bind for a round built from `body`. */
export const roundDigestOf = (round: number, body = ROUND_BODY): string => {
	const parsed = parseQuestionBlocks(body);
	if (parsed._tag !== "Blocks") never(`the fixture round body (${parsed.reason})`);
	const questions = addressBlocks(round, parsed.blocks) ?? never("the fixture round addresses");
	const digested = digestRound(questions);
	if (digested._tag !== "Digest") never(`the fixture round digest (${digested.reason})`);
	return digested.digest;
};

const id = (raw: string) => questionId(raw) ?? never(`the fixture question id "${raw}"`);
const digest = (raw: string) => roundDigest(raw) ?? never(`the fixture digest "${raw}"`);

export const rulingComment = (question: string, bound: string): string =>
	grillRuling.emit({question: id(question), digest: digest(bound), at: AT});

export const answerComment = (question: string, bound: string): string =>
	grillAnswer.emit({question: id(question), digest: digest(bound), at: AT});

export const supersedeComment = (
	entries: ReadonlyArray<{
		readonly question: string;
		readonly digest: string;
		readonly round: number;
	}>,
): string => {
	const [first, ...rest] = entries.map((entry) => ({
		question: id(entry.question),
		digest: digest(entry.digest),
		round: entry.round,
		at: AT,
	}));
	if (first === undefined) never("the fixture supersede marker");
	return grillSupersede.emit([first, ...rest]);
};

/** An authorization comment: quoted prose carrying an ISO-8601 date, as clause 4 requires. */
export const AUTHORIZATION =
	'2026-08-09 — he said, verbatim: "no, weight is earned per account. do it that way."\n';

export interface FakeComment {
	readonly id: number;
	readonly author: string;
	readonly body: string;
}

/** The `gh api --paginate .../comments` payload for a comment list. */
export const commentsPayload = (comments: ReadonlyArray<FakeComment>): string =>
	JSON.stringify(
		comments.map((comment) => ({
			id: comment.id,
			user: {login: comment.author},
			created_at: "2026-08-09T18:00:00Z",
			updated_at: "2026-08-09T18:00:00Z",
			body: comment.body,
		})),
	);

/** The `gh api repos/<repo>/issues/<n>` payload for a labelled session issue. */
export const sessionPayload = (
	session: number,
	options: {
		readonly labels?: ReadonlyArray<string>;
		readonly title?: string;
		readonly body?: string;
	} = {},
): string =>
	JSON.stringify({
		number: session,
		title: options.title ?? "sozluk moderation model",
		body: options.body ?? "",
		state: "open",
		labels: (options.labels ?? ["grilling:session"]).map((name) => ({name})),
		html_url: `https://example.test/issues/${session}`,
	});
