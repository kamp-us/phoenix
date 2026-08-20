/**
 * `glossary check` — row-shape, duplicate-key, ordering and citation-liveness defects.
 *
 * **All three outcomes exit 0**, because the outcome is this verb's own verdict: a caller must never
 * read its own finding list as a failed run, which is the mistake v1's `adr-sweep` made by exiting
 * non-zero on the one case it was asked to produce (#4723).
 *
 * **Zero scope is a red, with one carved-out exception.** A register present and holding zero rows is
 * `7` — a check that scanned nothing must never report `clean` (ADR 0092). An *absent* register is
 * `bootstrap` on exit `0`: refusing there would leave a fresh repo unable to run the skill at all
 * (#4776).
 *
 * Two defect classes are deliberately not computed here — machine-local paths and dead internal links
 * — because a merge-blocking gate already decides each, and a second answer could contradict it.
 */
import {Effect, Path, Result} from "effect";
import {idFromFile, isLive, statusOf} from "../adr/records.ts";
import {corpusOverride, decisionsDirOr} from "../config/paths.ts";
import {readDir, readFile} from "../io/fs.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {
	type CitationScope,
	type CitationState,
	citationsOf,
	findDefects,
	type RegisterRows,
	renderFinding,
} from "./findings.ts";
import {
	type GlossaryEffect,
	readRegister,
	registerFilesIn,
	resolveDir,
	selectRegisters,
} from "./guards.ts";

const VERB = "glossary check";

export interface CheckOptions {
	readonly register: string;
	readonly dir: string;
	/** `--decisions`, or `null` to resolve the corpus from `decisionsDir` (#6433). */
	readonly decisions: string | null;
	readonly json: boolean;
	readonly cwd: string;
}

const messages = {
	unreadable: (path: string, reason: string) =>
		`${VERB}: cannot read ${path}: ${reason} — the outcome is UNKNOWN, never "clean".`,
	malformed: (path: string, reason: string) =>
		`${VERB}: ${path} has no parseable term table (${reason}) — the outcome is UNKNOWN.`,
};

/**
 * Every cited id resolved against the corpus, or the reason the corpus could not be read.
 *
 * `wanted` is non-empty by precondition — `runCheck` answers the no-citations case as `Empty` before
 * any corpus is consulted, so this never reports an unread corpus nobody asked about (#6433).
 */
const resolveCitations = (
	dir: string,
	decisionsPath: string,
	wanted: ReadonlySet<string>,
): GlossaryEffect<CitationScope> =>
	Effect.gen(function* () {
		const states = new Map<string, CitationState>();
		const resolved = (): CitationScope => ({_tag: "Resolved", dir, states});

		const listing = yield* Effect.result(readDir(decisionsPath));
		if (Result.isFailure(listing)) {
			return {_tag: "Unverified", detail: `cannot read ${dir}: ${listing.failure.reason}`};
		}

		const byId = new Map<string, string>();
		for (const name of listing.success) {
			const id = idFromFile(name);
			if (id !== null && !byId.has(id)) byId.set(id, name);
		}
		for (const id of wanted) {
			const name = byId.get(id);
			if (name === undefined) {
				states.set(id, {_tag: "Dead"});
				continue;
			}
			const text = yield* Effect.result(readFile(`${decisionsPath}/${name}`));
			if (Result.isFailure(text)) {
				return {
					_tag: "Unverified",
					detail: `cannot read ${dir}: ${name} could not be read: ${text.failure.reason}`,
				};
			}
			const status = statusOf(text.success) ?? "";
			states.set(id, isLive(status) ? {_tag: "Live"} : {_tag: "Superseded", status});
		}
		return resolved();
	});

const citationScopeLine = (citations: CitationScope, wanted: number): string => {
	switch (citations._tag) {
		case "Empty":
			return `${VERB}: no four-digit citation in scope — no corpus was consulted.`;
		case "Unverified":
			return `${VERB}: ${wanted} citation(s) left unverified — ${citations.detail}`;
		case "Resolved":
			return `${VERB}: ${citations.states.size} of ${wanted} citation(s) resolved under ${citations.dir}.`;
	}
};

export const runCheck = (options: CheckOptions): GlossaryEffect<VerbOutcome> =>
	Effect.gen(function* () {
		const selected = selectRegisters(VERB, options.register, {allowed: true, refusal: ""});
		if (selected._tag === "Refused") return selected.outcome;

		const dir = yield* resolveDir(VERB, options.cwd, options.dir);
		if (dir._tag === "Refused") return dir.outcome;
		const pathService = yield* Path.Path;
		const files = registerFilesIn(dir.value, selected.value, pathService);

		const present: RegisterRows[] = [];
		const scope: string[] = [];
		let firstAbsent: string | null = null;
		for (const file of files) {
			const state = yield* readRegister(file, messages);
			if (state._tag === "Refused") return state.outcome;
			if (state.value._tag === "Absent") {
				if (firstAbsent === null) firstAbsent = file.display;
				scope.push(`${VERB}: ${file.display} — absent.`);
				continue;
			}
			const rows = state.value.parsed.rows;
			if (rows.length === 0) {
				return refuse(
					ZERO_SCOPE,
					`${VERB}: ${file.display} holds 0 rows — refusing to report a clean scan of an empty register (ADR 0092).`,
					scope,
				);
			}
			present.push({register: file.name, rows});
			scope.push(`${VERB}: ${file.display} — ${rows.length} row(s).`);
		}

		if (present.length === 0) {
			const reason = `no register at ${firstAbsent ?? dir.value.display} — nothing to check yet, which is bootstrap, not clean`;
			const diagnostics = [...scope, `${VERB}: ${reason}.`];
			return options.json
				? answer(
						JSON.stringify({
							outcome: "bootstrap",
							findings: [],
							reason,
							scannedRows: 0,
							scannedRegisters: 0,
							citationsResolved: 0,
						}),
						diagnostics,
					)
				: answer("bootstrap", diagnostics);
		}

		const wanted = new Set(
			present.flatMap(({rows}) => rows.flatMap((row) => [...citationsOf(row)])),
		);
		const corpus = yield* decisionsDirOr(
			VERB,
			options.cwd,
			corpusOverride("--decisions", options.decisions),
			"a row's four-digit citations cannot be resolved against anything.",
		);
		if (corpus._tag === "Refused") return refuse(PRECONDITION_UNKNOWN, corpus.message, scope);
		// The empty-citation answer is decided above the corpus fork, so both arms give it the same
		// answer: with nothing cited there is nothing a corpus could settle (#6433).
		const citations: CitationScope =
			wanted.size === 0
				? {_tag: "Empty"}
				: corpus._tag === "Declined"
					? {_tag: "Unverified", detail: corpus.message}
					: yield* resolveCitations(
							corpus.dir,
							pathService.resolve(dir.value.root, corpus.dir.replace(/\/+$/, "")),
							wanted,
						);
		scope.push(citationScopeLine(citations, wanted.size));

		const findings = findDefects({registers: present, citations});
		const scannedRows = present.reduce((total, entry) => total + entry.rows.length, 0);
		const outcome = findings.length === 0 ? "clean" : "defects";
		const reason =
			outcome === "clean"
				? `checked ${scannedRows} row(s) across ${present.length} register(s); no defect found`
				: null;
		const diagnostics = reason === null ? scope : [...scope, `${VERB}: ${reason}.`];

		if (options.json) {
			return answer(
				JSON.stringify({
					outcome,
					findings,
					reason,
					scannedRows,
					scannedRegisters: present.length,
					citationsResolved: citations._tag === "Resolved" ? citations.states.size : 0,
				}),
				diagnostics,
			);
		}
		return answer([outcome, ...findings.map(renderFinding)].join("\n"), diagnostics);
	});
