/**
 * `pattern corpus` — the library at a base ref: every doc, its registration, its section and its
 * last-touching commit.
 *
 * **Zero scope is an answer here, and the presence probe is what makes that safe.** The directory is
 * proven present by a pathspec read that exits `0` either way, so an empty listing is a directory
 * that exists and holds nothing rather than a directory nobody could find — precisely the
 * distinction `decisions-index next` does not make when it computes `max + 1` over an empty entry
 * set and hands a mis-rooted checkout `0001`.
 */
import {Effect} from "effect";
import {fetchAndResolve, listDir, readFileAt, type Shell} from "../io/git.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {PRECONDITION_UNKNOWN} from "./codes.ts";
import {type CorpusMember, type CorpusReading, readCorpus} from "./corpus.ts";
import {lastCommitTouching, pathPresentAt} from "./git.ts";
import {type ParsedIndex, parseIndex} from "./index-table.ts";

export interface CorpusOptions {
	readonly dir: string;
	readonly base: string;
	readonly json: boolean;
}

interface Entry extends CorpusMember {
	readonly lastSha: string;
	readonly lastDate: string;
}

const empty = (
	options: CorpusOptions,
	reading: CorpusReading,
	sha: string,
	extra: ReadonlyArray<string>,
): VerbOutcome =>
	answer(
		options.json
			? JSON.stringify({
					outcome: reading.outcome,
					docs: 0,
					unregistered: 0,
					unknown: 0,
					dangling: 0,
					entries: [],
					danglingRows: [],
					baseRef: options.base,
					baseSha: sha,
				})
			: ["corpus", reading.outcome, 0, 0, 0, 0].join("\t"),
		extra,
	);

export const runCorpus = (options: CorpusOptions): Shell<VerbOutcome> =>
	Effect.gen(function* () {
		const {dir, base, json} = options;

		const resolved = yield* fetchAndResolve(base);
		if (resolved._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`pattern corpus: cannot fetch ${base}: ${resolved.reason} — the corpus is UNKNOWN, never "none".`,
			);
		}
		const sha = resolved.value;
		const unreadable = (path: string, reason: string) =>
			refuse(
				PRECONDITION_UNKNOWN,
				`pattern corpus: cannot read ${path} at ${base}: ${reason} — UNKNOWN, never "absent".`,
			);

		const present = yield* pathPresentAt(sha, dir);
		if (present._tag === "Failure") return unreadable(dir, present.reason);
		if (!present.value) {
			const reading = readCorpus({present: false, names: [], index: null});
			return empty(options, reading, sha, [
				`pattern corpus: ${dir} is not in the tree at ${sha} — this repository has no pattern library yet.`,
			]);
		}

		const listed = yield* listDir(sha, dir);
		if (listed._tag === "Failure") return unreadable(dir, listed.reason);

		const indexPath = `${dir}/index.md`;
		let index: ParsedIndex | null = null;
		let indexNote: string | null = null;
		if (listed.value.includes("index.md")) {
			const text = yield* readFileAt(sha, indexPath);
			if (text._tag === "Failure") return unreadable(indexPath, text.reason);
			const parsed = parseIndex(text.value);
			if (parsed.hasTable) index = parsed;
			else indexNote = `${indexPath} holds no markdown table`;
		} else {
			indexNote = `${indexPath} is absent at ${sha}`;
		}

		const reading = readCorpus({present: true, names: listed.value, index});
		if (reading.outcome === "none") {
			return empty(options, reading, sha, [
				`pattern corpus: ${dir} at ${sha} holds no pattern doc — the library exists and is empty.`,
			]);
		}

		const entries: Entry[] = [];
		for (const member of reading.members) {
			const path = `${dir}/${member.slug}.md`;
			const last = yield* lastCommitTouching(sha, path);
			if (last._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`pattern corpus: cannot read the history of ${path}: ${last.reason} — UNKNOWN, never a missing commit.`,
				);
			}
			if (last.value === null) {
				return refuse(
					PRECONDITION_UNKNOWN,
					`pattern corpus: cannot read the history of ${path}: no commit touches it at or before ${sha} — UNKNOWN, never a missing commit.`,
				);
			}
			entries.push({...member, lastSha: last.value.sha, lastDate: last.value.date});
		}

		const scope = [
			`pattern corpus: scanned ${dir} at ${sha}; ${entries.length} doc(s), ${reading.unregistered} unregistered, ${reading.unknown} unknown, ${reading.dangling.length} dangling index row(s).`,
			...(indexNote === null
				? []
				: [
						`pattern corpus: ${indexNote} — every doc's registration is reported "unknown" rather than "unregistered", which this run did not prove.`,
					]),
		];

		if (json) {
			return answer(
				JSON.stringify({
					outcome: reading.outcome,
					docs: entries.length,
					unregistered: reading.unregistered,
					unknown: reading.unknown,
					dangling: reading.dangling.length,
					entries: entries.map((e) => ({
						slug: e.slug,
						registration: e.registration,
						section: e.section,
						lastSha: e.lastSha,
						lastDate: e.lastDate,
					})),
					danglingRows: reading.dangling.map((d) => ({target: d.target, section: d.section})),
					baseRef: base,
					baseSha: sha,
				}),
				scope,
			);
		}

		return answer(
			[
				[
					"corpus",
					reading.outcome,
					entries.length,
					reading.unregistered,
					reading.unknown,
					reading.dangling.length,
				].join("\t"),
				...entries.map((e) =>
					["doc", e.slug, e.registration, e.section, e.lastSha, e.lastDate].join("\t"),
				),
				...reading.dangling.map((d) => ["dangling", d.target, d.section].join("\t")),
			].join("\n"),
			scope,
		);
	});
