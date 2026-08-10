/**
 * `governance digest` — the decision records that landed in a window, each with its id, title,
 * status, landing commit and the anchor delta of that commit's own diff.
 *
 * **`none` is a proven answer at exit 0** — the window was walked and nothing landed in it. Empty
 * stdout would be byte-identical to a verb that never ran, which is v1's `adr-sweep.sh` scar.
 *
 * **The `status` field is reported, never interpreted.** Nine records on `main` read `proposed` while
 * being enforced at a live gate (#4388), so a consumer that treats `proposed` as "not law" is reading
 * a claim as an observation. The verb prints what is there and the skill judges what it means.
 *
 * **This verb ranks nothing.** Tension and blast radius are the two ruled ranking dimensions and both
 * are judgment; a ranking verb would be a second judgement wearing a verb's clothes.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {idFromFile, isFourDigitId, statusOf, titleOf} from "../adr/records.ts";
import {
	commitDiff,
	commitStatuses,
	fetchAndResolve,
	isShallowClone,
	listTreePaths,
	logCommitsTouching,
	parentlessCommitDates,
	readFileAt,
} from "../io/git.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {scanAnchors} from "./anchors.ts";
import {INCOMPLETE_SCAN, OFF_VOCABULARY, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";

const VERB = "governance digest";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface DigestOptions {
	readonly since: string;
	readonly until: string | null;
	readonly dir: string;
	readonly base: string;
	readonly json: boolean;
	/** The wall clock `--until` defaults from — a port so a test can pin the window's open end. */
	readonly now: Effect.Effect<number>;
}

/** One decision record that landed inside the window. */
export interface Landing {
	readonly id: string;
	readonly status: string;
	readonly commit: string;
	readonly date: string;
	readonly anchorsTouched: number;
	readonly title: string;
	readonly path: string;
}

export const runDigest = (
	options: DigestOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {json} = options;
		if (!DAY.test(options.since)) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --since "${options.since}" is not a YYYY-MM-DD date.`,
			);
		}
		const until = options.until ?? new Date(yield* options.now).toISOString().slice(0, 10);
		if (!DAY.test(until)) {
			return refuse(OFF_VOCABULARY, `${VERB}: --until "${until}" is not a YYYY-MM-DD date.`);
		}
		if (until < options.since) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --until ${until} precedes --since ${options.since} — an empty window is a usage error, not a result.`,
			);
		}
		const dir = options.dir.replace(/\/+$/, "");

		// The base is FETCHED before it is walked: a stale checkout is how withdrawn doctrine gets
		// applied after its withdrawal (#4338) and how four seats declared a merged ADR nonexistent
		// (#4163).
		const base = yield* fetchAndResolve(options.base);
		if (base._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot fetch or resolve ${options.base}: ${base.reason} — what landed is UNKNOWN, never "none".`,
			);
		}

		const shallow = yield* isShallowClone;
		if (shallow._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot tell whether this clone is shallow: ${shallow.reason} — what landed is UNKNOWN, never "none".`,
			);
		}
		if (shallow.value) {
			const boundary = yield* parentlessCommitDates(base.value);
			if (boundary._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read this clone's graft boundary: ${boundary.reason} — what landed is UNKNOWN, never "none".`,
				);
			}
			const inside = boundary.value.find((day) => day >= options.since && day <= until);
			if (inside !== undefined) {
				return refuse(
					INCOMPLETE_SCAN,
					`${VERB}: the history is shallow and its boundary at ${inside} falls inside the window — refusing a partial landing list (#3999's class).`,
				);
			}
		}

		const tree = yield* listTreePaths(base.value);
		if (tree._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot list ${dir} at ${base.value}: ${tree.reason} — what landed is UNKNOWN, never "none".`,
			);
		}
		const corpus = tree.value.filter(
			(path) => path.startsWith(`${dir}/`) && idFromFile(path.split("/").pop() ?? "") !== null,
		);
		if (corpus.length === 0) {
			return refuse(
				ZERO_SCOPE,
				`${VERB}: scanned ${dir}, 0 decision records — refusing to answer (ADR 0092).`,
			);
		}

		const commits = yield* logCommitsTouching(base.value, options.since, until, dir);
		if (commits._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot walk ${options.base}: ${commits.reason} — what landed is UNKNOWN, never "none".`,
			);
		}

		const records: Landing[] = [];
		for (const commit of commits.value) {
			const touched = yield* commitStatuses(commit.sha, dir);
			if (touched._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read landing commit ${commit.sha}: ${touched.reason} — the window is UNKNOWN.`,
				);
			}
			const diff = yield* commitDiff(commit.sha);
			if (diff._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read landing commit ${commit.sha}: ${diff.reason} — the window is UNKNOWN.`,
				);
			}
			const anchorsTouched = scanAnchors(diff.value).length;
			for (const entry of touched.value) {
				const id = idFromFile(entry.path.split("/").pop() ?? "");
				// A deletion has no frontmatter to read at this commit, and a lettered variant is not
				// addressable by the four-digit id every sibling verb takes.
				if (id === null || !isFourDigitId(id) || entry.status.startsWith("D")) continue;
				const bytes = yield* readFileAt(commit.sha, entry.path);
				if (bytes._tag === "Failure") {
					return refuse(
						PRECONDITION_UNKNOWN,
						`${VERB}: cannot read landing commit ${commit.sha}: ${bytes.reason} — the window is UNKNOWN.`,
					);
				}
				records.push({
					id,
					status: statusOf(bytes.value) ?? "",
					commit: commit.sha.slice(0, 8),
					date: commit.date,
					anchorsTouched,
					title: titleOf(bytes.value),
					path: entry.path,
				});
			}
		}

		const diagnostics = [
			`${VERB}: walked ${options.base} from ${options.since} to ${until}, ${commits.value.length} commits touching ${dir}.`,
		];
		const outcome = records.length === 0 ? "none" : "landed";
		if (json) {
			return answer(
				JSON.stringify({
					outcome,
					count: records.length,
					records,
					window: {since: options.since, until},
					base: options.base,
				}),
				diagnostics,
			);
		}
		return answer(
			[
				`digest\t${outcome}\t${records.length}`,
				...records.map(
					(row) =>
						`landed\t${row.id}\t${row.status}\t${row.commit}\t${row.date}\t${row.anchorsTouched}\t${row.title}`,
				),
			].join("\n"),
			diagnostics,
		);
	});
