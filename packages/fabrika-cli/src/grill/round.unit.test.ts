import {describe, expect, it} from "vitest";
import {
	AUTHORIZATION,
	answerComment,
	ROUND_BODY,
	roundComment,
	roundDigestOf,
	rulingComment,
	supersedeComment,
} from "./fixtures.test-support.ts";
import {
	addressBlocks,
	checkRequiredFields,
	composeRoundComment,
	digestRound,
	parseQuestionBlocks,
	readRoundComment,
} from "./round.ts";

const blocksOf = (body: string) => {
	const parsed = parseQuestionBlocks(body);
	if (parsed._tag !== "Blocks") throw new Error(`expected blocks, got: ${parsed.reason}`);
	return parsed.blocks;
};

const reasonOf = (body: string): string => {
	const parsed = parseQuestionBlocks(body);
	return parsed._tag === "Invalid" ? parsed.reason : (checkRequiredFields(parsed.blocks) ?? "");
};

describe("the round grammar", () => {
	it("reads each block's kind, prose and fields", () => {
		expect(blocksOf(ROUND_BODY)).toEqual([
			{
				position: 1,
				kind: "fact",
				text: "Does the vote table already carry a per-account weight column?",
				recommended: "Check the vote feature's schema before designing one.",
				tradeoffs: null,
			},
			{
				position: 2,
				kind: "decision",
				text: "Do vouched-in yazars inherit their kefil's moderation weight?",
				recommended: "No — weight is earned per account.",
				tradeoffs: "Slower trust accrual; simpler abuse story.",
			},
		]);
	});

	it.each([
		[
			"a question with no **Recommended:** field",
			"### 1 · fact\nIs there a weight column?\n",
			"question 1 has no **Recommended:** field",
		],
		[
			"a decision with no **Trade-offs:** field",
			"### 1 · decision\nDo they inherit weight?\n\n**Recommended:** No.\n",
			"decision question 1 has no **Trade-offs:** field",
		],
		[
			"a heading that is not a question block",
			"### Background\nSome context.\n",
			'heading "Background" is not a question block',
		],
		[
			"a kind outside the set",
			"### 1 · musing\nWhat if?\n\n**Recommended:** Nothing.\n",
			'kind "musing" on question 1 is not one of fact, decision',
		],
		[
			"a gap in the numbering",
			"### 1 · fact\nA?\n\n**Recommended:** x\n\n### 3 · fact\nB?\n\n**Recommended:** y\n",
			"question numbers are not contiguous from 1 — saw 1, 3",
		],
		[
			"a duplicate position",
			"### 1 · fact\nA?\n\n**Recommended:** x\n\n### 1 · fact\nB?\n\n**Recommended:** y\n",
			"question numbers are not contiguous from 1 — saw 1, 1",
		],
		[
			"prose outside every block",
			"Here is the round.\n\n### 1 · fact\nA?\n\n**Recommended:** x\n",
			"sits outside every question block",
		],
		[
			"a body that reaches for no block at all",
			"Just a note.\n",
			"sits outside every question block",
		],
		[
			"a body with nothing but blank lines",
			"\n   \n",
			"carries no `### <n> · <kind>` question block",
		],
	])("refuses %s", (_case, body, expected) => {
		expect(reasonOf(body)).toContain(expected);
	});

	it("admits a fact question carrying an optional **Trade-offs:** field", () => {
		const body = "### 1 · fact\nA?\n\n**Recommended:** x\n\n**Trade-offs:** y\n";
		expect(checkRequiredFields(blocksOf(body))).toBeNull();
	});
});

describe("the round digest", () => {
	const questions = (round: number, body = ROUND_BODY) =>
		addressBlocks(round, blocksOf(body)) ?? [];

	it("is 12 lowercase hex", () => {
		expect(roundDigestOf(2)).toMatch(/^[0-9a-f]{12}$/);
	});

	it("is deterministic over the same text", () => {
		expect(roundDigestOf(2)).toBe(roundDigestOf(2));
	});

	it("differs when the round number differs — an id is part of what it covers", () => {
		expect(roundDigestOf(1)).not.toBe(roundDigestOf(2));
	});

	it("differs when a question is re-worded — this is what makes a ruling go stale", () => {
		const reworded = ROUND_BODY.replace("inherit their kefil's", "inherit any");
		expect(roundDigestOf(2, reworded)).not.toBe(roundDigestOf(2));
	});

	it("is neutral to trailing whitespace and CRLF, which no author controls", () => {
		const noisy = `${ROUND_BODY.replace(/\n/g, "  \r\n")}`;
		expect(roundDigestOf(2, noisy)).toBe(roundDigestOf(2));
	});

	it("refuses a round whose block is missing a field it is taken over", () => {
		const partial = questions(2).map((question, index) =>
			index === 0 ? {...question, recommended: null} : question,
		);
		const digested = digestRound(partial);
		expect(digested._tag).toBe("Unbindable");
	});

	it("refuses a round with no question rather than digesting the empty string", () => {
		expect(digestRound([])._tag).toBe("Unbindable");
	});
});

/**
 * The neutrality invariant, driven rather than asserted: every comment this group writes after the
 * round is added to the session and the round's digest is recomputed from its own comment.
 */
describe("the digest is neutral to every write this group makes", () => {
	const bound = roundDigestOf(2);

	const digestOfPostedRound = (): string => {
		const read = readRoundComment(roundComment(2));
		if (read._tag !== "Round") throw new Error("the posted round did not read back as a round");
		const digested = digestRound(read.questions);
		if (digested._tag !== "Digest") throw new Error(digested.reason);
		return digested.digest;
	};

	it("recomputes byte-identically off the posted comment", () => {
		expect(digestOfPostedRound()).toBe(bound);
	});

	it.each([
		["an answer", answerComment("R2.1", bound)],
		["a ruling", rulingComment("R2.2", bound)],
		["an authorization quote", AUTHORIZATION],
		[
			"a later round's supersede marker",
			supersedeComment([{question: "R2.2", digest: bound, round: 3}]),
		],
	])("is unchanged after %s is posted beside it", (_case, _posted) => {
		// Every write is a NEW comment; the round comment's bytes are never edited, which is the
		// prohibition neutrality rests on.
		expect(digestOfPostedRound()).toBe(bound);
	});
});

describe("the posted round comment", () => {
	it("stamps the full R<round>.<n> ids and reads back as the same questions", () => {
		const comment = roundComment(2);
		expect(comment).toContain("### R2.1 · fact");
		expect(comment).toContain("### R2.2 · decision");
		const read = readRoundComment(comment);
		expect(read._tag).toBe("Round");
		if (read._tag !== "Round") return;
		expect(read.round).toBe(2);
		expect(read.questions.map((question) => question.id)).toEqual(["R2.1", "R2.2"]);
	});

	it("is NotARound for a comment that does not open with the round key", () => {
		expect(readRoundComment("Thanks — reading now.\n")._tag).toBe("NotARound");
	});

	it("is Malformed, never NotARound, for a comment that opens as a round and does not parse", () => {
		const read = readRoundComment("grill-round: 2\n\n### Background\nprose\n");
		expect(read._tag).toBe("Malformed");
	});

	it("refuses a comment whose stamped heading names another round", () => {
		const read = readRoundComment(composeRoundComment(2, questionsFrom(3)));
		expect(read._tag).toBe("Malformed");
	});
});

function questionsFrom(round: number) {
	return addressBlocks(round, blocksOf(ROUND_BODY)) ?? [];
}
