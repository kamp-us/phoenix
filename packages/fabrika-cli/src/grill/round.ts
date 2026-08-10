/**
 * The round grammar, the round comment, and the digest that binds a ruling to what it ruled.
 *
 * A round is one or more question blocks and nothing else. The caller writes only the position
 * within the round; `grill round` derives the round number and stamps the full `R<round>.<n>` id
 * into the comment it posts, because a caller that had to supply the round number would have to
 * guess which round it is on, and every guess after round one is a collision.
 *
 * **`**Recommended:**` is required on every question, both kinds.** v1 banned a recommendation
 * outright; the founder's ruled shape requires one. The two conflict only while the recommendation
 * and the ruling share a surface, and here they do not: a recommendation is agent-authored body
 * text inside a question block and is never authority, while a ruling is a marker in its own
 * comment resolved against the ACL and an adjacent authorization.
 *
 * <!-- anchor: DIGEST-NEUTRALITY --> **Named invariant — the digest is neutral to every write this
 * group makes.** It covers the round's question text only: no ruling, no answer, no comment posted
 * afterwards, and no field any verb mutates. It must be, because the digest binds rulings and
 * rulings are exactly what gets written afterwards — a digest covering them would be invalidated by
 * the very operation it exists to protect, and every clean binding would then attest a round no
 * check ever ran over. Neutrality also rests on a prohibition stated elsewhere and worth repeating
 * at the one place it could be broken: **no verb edits an existing comment.** Marking a retirement
 * by editing round *x*'s comment would change text this function covers.
 *
 * **A question can exist while its round cannot be digested.** That is why parsing is two-staged:
 * {@link parseQuestionBlocks} names every question whose heading conforms, and {@link digestRound}
 * refuses separately when a block is missing a field the digest is taken over. The two seat
 * different codes — `QUESTION_UNKNOWN` and `DIGEST_UNBINDABLE` — and folding them would let an
 * unbindable marker read as a question nobody asked.
 */

import {createHash} from "node:crypto";
import {
	composeQuestionId,
	FIELD_SEPARATOR,
	type QuestionId,
	questionId,
	type RoundDigest,
	roundDigest,
} from "../wire/grill-marker.ts";

/** What a question is for: a fact an agent establishes, or a decision only the founder makes. */
export type Kind = "fact" | "decision";

export const KINDS: ReadonlyArray<Kind> = ["fact", "decision"];

const isKind = (value: string): value is Kind => (KINDS as ReadonlyArray<string>).includes(value);

/** The first line of a posted round comment, which is what makes a comment findable as a round. */
export const ROUND_KEY = "grill-round";

/** One question as the grammar admits it — its fields optional, so a defect is nameable per field. */
export interface QuestionBlock {
	readonly position: number;
	readonly kind: Kind;
	readonly text: string;
	readonly recommended: string | null;
	readonly tradeoffs: string | null;
}

export type BlockParse =
	| {readonly _tag: "Blocks"; readonly blocks: ReadonlyArray<QuestionBlock>}
	/** A grammar defect: the reason is the verb's stderr line, seated on `BAD_SECTIONS`. */
	| {readonly _tag: "Invalid"; readonly reason: string};

const HEADING = /^###[ \t]+(.*?)[ \t]*$/;
const FIELD = /^\*\*(Recommended|Trade-offs):\*\*[ \t]*(.*)$/;

/** `<position> · <kind>` or the stamped `R<round>.<position> · <kind>` a posted comment carries. */
const headingParts = (
	text: string,
): {readonly position: number; readonly kind: string; readonly round: number | null} | null => {
	const [left, ...right] = text.split(FIELD_SEPARATOR);
	if (right.length === 0) return null;
	const address = (left ?? "").trim();
	const kind = right.join(FIELD_SEPARATOR).trim();
	const stamped = questionId(address);
	if (stamped !== null) {
		const [round, position] = stamped.slice(1).split(".");
		return {position: Number(position), kind, round: Number(round)};
	}
	return /^[1-9][0-9]*$/.test(address) ? {position: Number(address), kind, round: null} : null;
};

const blank = (line: string): boolean => line.trim() === "";

/** Normalize to LF and strip trailing whitespace per line — the digest's canonical form. */
export const canonicalize = (text: string): string =>
	text
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.replace(/[ \t]+$/, ""))
		.join("\n");

/**
 * Parse a round body into its question blocks.
 *
 * Total over the bytes: every refusal names the question and the field, because a caller told only
 * that "the round is malformed" re-sends the same round.
 */
export const parseQuestionBlocks = (
	body: string,
	expectRound: number | null = null,
): BlockParse => {
	const lines = canonicalize(body).split("\n");
	const blocks: QuestionBlock[] = [];

	let current: {
		position: number;
		kind: Kind;
		text: string[];
		field: "Recommended" | "Trade-offs" | null;
		recommended: string[] | null;
		tradeoffs: string[] | null;
	} | null = null;

	const close = (): void => {
		if (current === null) return;
		blocks.push({
			position: current.position,
			kind: current.kind,
			text: current.text.join("\n").trim(),
			recommended: current.recommended === null ? null : current.recommended.join("\n").trim(),
			tradeoffs: current.tradeoffs === null ? null : current.tradeoffs.join("\n").trim(),
		});
		current = null;
	};

	for (const line of lines) {
		const heading = HEADING.exec(line);
		if (heading !== null) {
			close();
			const raw = heading[1] ?? "";
			const parts = headingParts(raw);
			if (parts === null) {
				return {_tag: "Invalid", reason: `heading "${raw}" is not a question block.`};
			}
			if (!isKind(parts.kind)) {
				return {
					_tag: "Invalid",
					reason: `kind "${parts.kind}" on question ${parts.position} is not one of ${KINDS.join(", ")}.`,
				};
			}
			if (expectRound !== null && parts.round !== null && parts.round !== expectRound) {
				return {
					_tag: "Invalid",
					reason: `heading "${raw}" names round ${parts.round} in the comment for round ${expectRound}.`,
				};
			}
			current = {
				position: parts.position,
				kind: parts.kind,
				text: [],
				field: null,
				recommended: null,
				tradeoffs: null,
			};
			continue;
		}

		if (current === null) {
			if (blank(line) || line.trim().startsWith(`${ROUND_KEY}:`)) continue;
			return {
				_tag: "Invalid",
				reason: `"${line.trim()}" sits outside every question block — a round is question blocks and nothing else.`,
			};
		}

		const field = FIELD.exec(line);
		if (field !== null) {
			const name = field[1] === "Recommended" ? "Recommended" : "Trade-offs";
			current.field = name;
			const first = field[2] ?? "";
			if (name === "Recommended") current.recommended = [first];
			else current.tradeoffs = [first];
			continue;
		}

		if (current.field === "Recommended") current.recommended?.push(line);
		else if (current.field === "Trade-offs") current.tradeoffs?.push(line);
		else current.text.push(line);
	}
	close();

	if (blocks.length === 0) {
		return {_tag: "Invalid", reason: "the round carries no `### <n> · <kind>` question block."};
	}

	const positions = blocks.map((block) => block.position);
	const contiguous = positions.every((position, index) => position === index + 1);
	if (!contiguous) {
		return {
			_tag: "Invalid",
			reason: `question numbers are not contiguous from 1 — saw ${positions.join(", ")}.`,
		};
	}

	return {_tag: "Blocks", blocks};
};

/**
 * The grammar's required-field checks, applied to blocks that already parsed.
 *
 * Separate from {@link parseQuestionBlocks} because the posted-comment reader wants the blocks
 * without the checks: a round comment missing a field is a round whose questions still exist and
 * whose digest is unbindable, which is two different answers.
 */
export const checkRequiredFields = (blocks: ReadonlyArray<QuestionBlock>): string | null => {
	for (const block of blocks) {
		if (block.text === "") {
			return `question ${block.position} carries no question text.`;
		}
		if (block.recommended === null || block.recommended === "") {
			return `question ${block.position} has no **Recommended:** field — every question carries a recommended answer.`;
		}
		if (block.kind === "decision" && (block.tradeoffs === null || block.tradeoffs === "")) {
			return `decision question ${block.position} has no **Trade-offs:** field.`;
		}
	}
	return null;
};

/** A question with its full address, as it reads on the session right now. */
export interface Question extends QuestionBlock {
	readonly id: QuestionId;
	readonly round: number;
}

/** Address a round's blocks. `null` when a position cannot form an id — refused, never guessed. */
export const addressBlocks = (
	round: number,
	blocks: ReadonlyArray<QuestionBlock>,
): ReadonlyArray<Question> | null => {
	const addressed: Question[] = [];
	for (const block of blocks) {
		const id = composeQuestionId(round, block.position);
		if (id === null) return null;
		addressed.push({...block, id, round});
	}
	return addressed;
};

export type DigestResult =
	| {readonly _tag: "Digest"; readonly digest: RoundDigest}
	| {readonly _tag: "Unbindable"; readonly reason: string};

const DIGEST_LENGTH = 12;

/**
 * The round digest: the first 12 lowercase hex of the SHA-256 of the round's question text only.
 *
 * For each question in id order — its id, its kind, its question prose, its `**Recommended:**`
 * value and its `**Trade-offs:**` value — joined by `\n`, LF-normalized, trailing whitespace
 * stripped per line. See the module docblock for why the covered set stops there.
 */
export const digestRound = (questions: ReadonlyArray<Question>): DigestResult => {
	if (questions.length === 0) {
		return {_tag: "Unbindable", reason: "the round holds no question block"};
	}
	const parts: string[] = [];
	for (const question of questions) {
		if (question.recommended === null) {
			return {
				_tag: "Unbindable",
				reason: `${question.id} carries no **Recommended:** field, so there is no text to digest`,
			};
		}
		if (question.kind === "decision" && question.tradeoffs === null) {
			return {
				_tag: "Unbindable",
				reason: `${question.id} is a decision question carrying no **Trade-offs:** field, so there is no text to digest`,
			};
		}
		parts.push(
			question.id,
			question.kind,
			question.text,
			question.recommended,
			question.tradeoffs ?? "",
		);
	}
	const hex = createHash("sha256")
		.update(canonicalize(parts.join("\n")), "utf8")
		.digest("hex");
	const digest = roundDigest(hex.slice(0, DIGEST_LENGTH));
	if (digest === null) {
		// Unreachable: SHA-256 hex is lowercase and 64 characters long. Refused rather than cast,
		// because a `Digest` carrying something else is the one value the brand exists to forbid.
		return {_tag: "Unbindable", reason: "the SHA-256 digest did not render as 12 lowercase hex"};
	}
	return {_tag: "Digest", digest};
};

/** The comment body `grill round` posts: the round key, then one stamped block per question. */
export const composeRoundComment = (round: number, questions: ReadonlyArray<Question>): string => {
	const blocks = questions.map((question) => {
		const lines = [`### ${question.id} ${FIELD_SEPARATOR} ${question.kind}`, "", question.text, ""];
		lines.push(`**Recommended:** ${question.recommended ?? ""}`);
		if (question.tradeoffs !== null) lines.push("", `**Trade-offs:** ${question.tradeoffs}`);
		return lines.join("\n");
	});
	return `${ROUND_KEY}: ${round}\n\n${blocks.join("\n\n")}\n`;
};

export type RoundComment =
	| {readonly _tag: "Round"; readonly round: number; readonly questions: ReadonlyArray<Question>}
	/** The comment opens as a round and its blocks do not parse — visible, never silently skipped. */
	| {readonly _tag: "Malformed"; readonly round: number; readonly reason: string}
	| {readonly _tag: "NotARound"};

const ROUND_LINE = new RegExp(`^\\*{0,2}\\s*${ROUND_KEY}:[ \\t]*([1-9][0-9]*)\\s*\\*{0,2}$`);

/** Read one comment body as a round. Three answers, and the middle one is the reason for the type. */
export const readRoundComment = (body: string): RoundComment => {
	const first = canonicalize(body)
		.split("\n")
		.find((line) => line.trim() !== "")
		?.trim();
	const matched = first === undefined ? null : ROUND_LINE.exec(first);
	if (matched === null) return {_tag: "NotARound"};
	const round = Number(matched[1]);
	const parsed = parseQuestionBlocks(body, round);
	if (parsed._tag === "Invalid") return {_tag: "Malformed", round, reason: parsed.reason};
	const addressed = addressBlocks(round, parsed.blocks);
	if (addressed === null) {
		return {
			_tag: "Malformed",
			round,
			reason: "a question position does not form an R<round>.<n> id",
		};
	}
	return {_tag: "Round", round, questions: addressed};
};
