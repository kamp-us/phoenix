/**
 * `graduate read` — the total three-valued read of a source's emission markers.
 *
 * <!-- anchor: READ-NEVER-REFUSES-ON-CONTENT --> **This verb never refuses on marker content.** A
 * malformed marker is data: a `disregarded` row at exit `0`, never a refusal. Refusing would suppress
 * the whole emission history over one bad comment, and would let anyone with write access disable the
 * verb by posting one. Its only refusals are a source proven absent (`7`), one carrying neither label
 * (`12`), and a read that could not complete (`11`).
 *
 * <!-- anchor: MALFORMED-IS-NOT-UNGRADUATED --> A source whose only marker is malformed reads
 * `ungraduated` with a non-empty `disregarded`, and a caller must read both. That is knowingly
 * conservative in the unsafe direction — `graduate emit` treats a malformed marker as unparseable too,
 * so a mangled one can let a second spec be filed — and it is stated rather than hidden. The
 * alternative, refusing every emission whenever any comment is malformed, would let one bad comment
 * block a source forever.
 *
 * Coverage is derivable from `covers` and is deliberately **not** computed here: unioning the arrays
 * against a trail is the caller's arithmetic, and doing it here would cost this verb its split test.
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {type CommentRecord, listComments, resolveRepo} from "../io/issues.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import * as graduateEmitted from "../wire/graduate-emitted.ts";
import {PRECONDITION_UNKNOWN} from "./codes.ts";
import {requireSource} from "./source.ts";

export interface ReadOptions {
	readonly source: number;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/** One parsed emission, as this verb reports it. */
export interface Emission {
	readonly issue: number;
	readonly specDigest: string;
	readonly covers: ReadonlyArray<string>;
	readonly emittedAt: string;
	readonly comment: number;
}

/** A purported marker not counted. `reason` is a closed set of one, so a consumer can branch on it. */
export interface Disregarded {
	readonly comment: number;
	readonly reason: "malformed";
	readonly detail: string;
}

export interface MarkerScan {
	readonly emissions: ReadonlyArray<Emission>;
	readonly disregarded: ReadonlyArray<Disregarded>;
}

/** Every emission marker on a comment list, oldest first, with every drift surfaced beside it. */
export const scanEmissions = (comments: ReadonlyArray<CommentRecord>): MarkerScan => {
	const emissions: Emission[] = [];
	const disregarded: Disregarded[] = [];
	for (const comment of comments) {
		const read = graduateEmitted.read(comment.body);
		if (read._tag === "Absent") continue;
		if (read._tag === "Malformed") {
			disregarded.push({comment: comment.id, reason: "malformed", detail: read.reason});
			continue;
		}
		emissions.push({
			issue: read.value.emitted,
			specDigest: read.value.digest,
			covers: read.value.covers,
			emittedAt: read.value.at,
			comment: comment.id,
		});
	}
	return {emissions, disregarded};
};

const VERB = "graduate read";

export const runRead = (
	options: ReadOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {source} = options;
		if (!Number.isInteger(source) || source <= 0) {
			return refuse(FAILED, `${VERB}: ${source} is not an issue number.`);
		}

		const repoAttempt = yield* resolveRepo(options.repo, options.env);
		if (repoAttempt._tag === "Failure") {
			return refuse(
				FAILED,
				`${VERB}: cannot resolve a target repo — pass --repo, or run inside a checkout whose origin remote resolves.`,
			);
		}
		const repo = repoAttempt.value;

		const found = yield* requireSource(VERB, repo, source, ".");
		if (found._tag === "Refused") return found.outcome;

		const comments = yield* listComments(repo, source);
		if (comments._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the comments on #${source}: ${comments.reason} — whether this source graduated is UNKNOWN, never "no".`,
			);
		}

		const scan = scanEmissions(comments.value);
		return answer(
			JSON.stringify({
				source,
				state: scan.emissions.length > 0 ? "graduated" : "ungraduated",
				emissions: scan.emissions,
				disregarded: scan.disregarded,
				scanned: {comments: comments.value.length},
			}),
			[
				`${VERB}: ${repo}#${source}, ${comments.value.length} comment(s) scanned, ${scan.emissions.length} emission(s) parsed, ${scan.disregarded.length} disregarded.`,
			],
		);
	});
