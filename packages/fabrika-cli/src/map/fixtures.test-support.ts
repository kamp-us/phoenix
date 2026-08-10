/**
 * The map bodies and `gh api` responses every `map` verb test is driven from.
 *
 * Shared so the eight verb suites assert against one canonical map rather than each inventing its
 * own: a fixture per suite is how two tests come to disagree about what a well-formed body is, and
 * the digest guard makes that disagreement invisible until a write refuses.
 */

import {digestOfBody, type MapBody, parseBody} from "./body.ts";

export const REPO = "o/r";
export const MAP = 9140;
export const TICKET = 9142;
export const NONCE = "7f3a9c21";

/** A map with one open research ticket, no decisions, and nothing out of scope. */
export const MAP_BODY = [
	"## Destination",
	"how moderation weight is earned",
	"",
	"## Decisions",
	"",
	"## Frontier",
	"- #9142 · research — which table carries the per-account weight column?",
	"",
	"## Fog",
	"- what clock does weight decay on?",
	"",
	"## Out of scope",
	"",
].join("\n");

/** The same map with one rejected direction already recorded. */
export const MAP_BODY_WITH_REJECTION = MAP_BODY.replace(
	"## Out of scope\n",
	"## Out of scope\n- a per-topic weight multiplier. It makes every moderation action's authority unreadable without a topic lookup — 2026-06-29\n",
);

export const parsed = (body: string): MapBody => {
	const read = parseBody(body);
	if (read._tag === "Malformed") throw new Error(`fixture does not parse: ${read.reason}`);
	return read.value;
};

export const digestFor = (body: string): string => digestOfBody(parsed(body));

export const issueJson = (input: {
	readonly number: number;
	readonly title?: string;
	readonly body?: string;
	readonly labels?: ReadonlyArray<string>;
	readonly state?: string;
}): string =>
	JSON.stringify({
		number: input.number,
		title: input.title ?? `issue ${input.number}`,
		body: input.body ?? "",
		state: input.state ?? "open",
		labels: (input.labels ?? []).map((name) => ({name})),
		html_url: `https://github.com/${REPO}/issues/${input.number}`,
		user: {login: "usirin"},
		milestone: null,
		state_reason: null,
	});

export const commentsJson = (
	comments: ReadonlyArray<{readonly id: number; readonly body: string; readonly author?: string}>,
): string =>
	JSON.stringify(
		comments.map((comment) => ({
			id: comment.id,
			body: comment.body,
			user: {login: comment.author ?? "usirin"},
			created_at: "2026-08-10T00:00:00Z",
			updated_at: "2026-08-10T00:00:00Z",
		})),
	);
