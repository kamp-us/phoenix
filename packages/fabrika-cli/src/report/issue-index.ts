import type {IssueDocument} from "../io/issue-document.ts";
import {TOKEN_FLOOR, tokenize, tokensMatch} from "./dedup.ts";

export const DEFAULT_CLOSED_DAYS = 14;
export const EXCERPT_LENGTH = 800;
export const RETRIEVAL_LIMIT = 20;
const DAY = 86_400_000;

export const closedCutoff = (now: number, days: number): string =>
	new Date(now - days * DAY).toISOString();

export const inWindow = (issue: IssueDocument, cutoff: string, days: number): boolean =>
	issue.state === "open" || (days > 0 && Date.parse(issue.closed_at) >= Date.parse(cutoff));

export const excerpt = (body: string | null): string =>
	(body ?? "").replace(/https?:\/\/\S+|#\d+/g, " ").slice(0, EXCERPT_LENGTH);

export interface IndexedCandidate {
	readonly number: number;
	readonly title: string;
	readonly state: "open" | "closed";
	readonly source: "queue" | "index" | "both";
	readonly score: number;
}

const terms = (text: string): ReadonlyArray<string> => tokenize(text, Number.POSITIVE_INFINITY);
const words = (text: string): ReadonlyArray<string> => {
	const vocabulary = new Set(terms(text));
	return text
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((word) => vocabulary.has(word));
};

/** @ruling https://github.com/kamp-us/phoenix/issues/6923 */
export class DuplicateIndex {
	readonly issues: ReadonlyArray<IssueDocument>;
	constructor(issues: ReadonlyArray<IssueDocument>) {
		this.issues = issues;
	}

	search(
		query: string,
		queue: ReadonlyArray<IssueDocument>,
		limit: number,
		exclude: number | null,
	) {
		const tokens = terms(query);
		if (tokens.length < TOKEN_FLOOR)
			return {
				outcome: "indeterminate" as const,
				candidates: [],
				tokens,
				truncated: false,
				retrievalTruncated: false,
				reason: `the query yielded ${tokens.length} distinctive token(s), below the floor of ${TOKEN_FLOOR}`,
			};
		const indexed = new Set(this.issues.map((issue) => issue.number));
		const queued = new Set(queue.map((issue) => issue.number));
		const merged = new Map(this.issues.map((issue) => [issue.number, issue]));
		for (const issue of queue) merged.set(issue.number, issue);
		if (exclude !== null) merged.delete(exclude);
		const issues = [...merged.values()];
		const scores = new Map<number, number>();
		let retrievalTruncated = false;
		for (const withBody of [false, true]) {
			const documents = issues.map((issue) =>
				words(withBody ? `${issue.title} ${excerpt(issue.body)}` : issue.title),
			);
			const averageLength =
				documents.reduce((sum, doc) => sum + doc.length, 0) / (documents.length || 1);
			const frequency = new Map(
				tokens.map((token) => [
					token,
					documents.filter((doc) => doc.some((word) => tokensMatch(token, word))).length,
				]),
			);
			const ranked = issues
				.map((issue, i) => {
					const doc = documents[i] ?? [];
					let score = 0;
					for (const token of tokens) {
						if (!doc.some((word) => tokensMatch(token, word))) continue;
						const df = frequency.get(token) ?? 0;
						const idf = Math.log(1 + (issues.length - df + 0.5) / (df + 0.5));
						const tf = doc.filter((word) => tokensMatch(token, word)).length;
						score +=
							(idf * tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * doc.length) / (averageLength || 1)));
					}
					return {number: issue.number, score};
				})
				.filter((row) => row.score > 0)
				.sort((a, b) => b.score - a.score || b.number - a.number);
			retrievalTruncated ||= ranked.length > RETRIEVAL_LIMIT;
			for (const [i, row] of ranked.slice(0, RETRIEVAL_LIMIT).entries())
				scores.set(row.number, (scores.get(row.number) ?? 0) + 1 / (61 + i));
		}
		const candidates: IndexedCandidate[] = issues.flatMap((issue) => {
			const score = scores.get(issue.number);
			return score === undefined
				? []
				: [
						{
							number: issue.number,
							title: issue.title,
							state: issue.state,
							score,
							source: queued.has(issue.number)
								? indexed.has(issue.number)
									? "both"
									: "queue"
								: "index",
						},
					];
		});
		candidates.sort((a, b) => b.score - a.score || b.number - a.number);
		return {
			outcome: candidates.length === 0 ? ("none" as const) : ("candidates" as const),
			candidates: candidates.slice(0, limit),
			tokens,
			truncated: candidates.length > limit,
			retrievalTruncated,
			reason:
				candidates.length === 0 ? "no lexical matches in the live queue and indexed corpus" : null,
		};
	}
}

export const renderIndexedCandidate = (candidate: IndexedCandidate): string =>
	`${candidate.number}\t${candidate.source}\t${candidate.score}\t${candidate.state}\t${candidate.title.replace(/[\t\r\n]/g, " ")}`;
