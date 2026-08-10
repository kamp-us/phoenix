/**
 * `glossary lookup` — whether a term is already declared, and what overlaps it.
 *
 * **All three states are answers on exit 0.** `absent` means *proven absent against a register that
 * was read* — never what a failed read prints, which is `11`.
 *
 * `declared` beats `collision` beats `absent`, and TERMS is searched before LANGUAGE, so a term
 * declared in both is reported once as `declared` in TERMS. That duplication is a defect
 * `glossary check` reports as `cross-register` (#4465); reporting it twice here would make one term
 * look like two.
 */
import {Effect, Path} from "effect";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {
	type GlossaryEffect,
	readRegister,
	registerFilesIn,
	resolveDir,
	selectRegisters,
} from "./guards.ts";
import {normalizeKey, overlaps, type Row} from "./register.ts";

const VERB = "glossary lookup";

export interface LookupOptions {
	readonly terms: ReadonlyArray<string>;
	readonly register: string;
	readonly dir: string;
	readonly json: boolean;
	readonly cwd: string;
}

interface Resolution {
	readonly term: string;
	readonly normalized: string;
	readonly state: "declared" | "collision" | "absent";
	readonly register: string | null;
	readonly section: string | null;
	readonly matched: ReadonlyArray<string>;
}

/** A row plus which register holds it, so file order across `both` stays one sequence. */
interface Declared {
	readonly row: Row;
	readonly register: string;
}

const messages = {
	unreadable: (path: string, reason: string) =>
		`${VERB}: cannot read ${path}: ${reason} — every state is UNKNOWN, never "absent".`,
	malformed: (path: string, reason: string) =>
		`${VERB}: ${path} has no parseable term table (${reason}) — membership is UNKNOWN, never "absent".`,
};

const resolve = (term: string, corpus: ReadonlyArray<Declared>): Resolution => {
	const normalized = normalizeKey(term);
	const exact = corpus.find((entry) => entry.row.key === normalized);
	if (exact !== undefined) {
		return {
			term,
			normalized,
			state: "declared",
			register: exact.register,
			section: exact.row.section,
			matched: [exact.row.term],
		};
	}
	const overlapping = corpus.filter((entry) => overlaps(entry.row.key, normalized));
	const first = overlapping[0];
	if (first === undefined) {
		return {term, normalized, state: "absent", register: null, section: null, matched: []};
	}
	return {
		term,
		normalized,
		state: "collision",
		register: first.register,
		section: first.row.section,
		matched: overlapping.map((entry) => entry.row.term),
	};
};

const renderLine = (resolution: Resolution): string =>
	[
		resolution.state,
		resolution.register ?? "-",
		resolution.section ?? "-",
		resolution.matched.length === 0 ? "-" : resolution.matched.join(", "),
	].join("\t");

export const runLookup = (options: LookupOptions): GlossaryEffect<VerbOutcome> =>
	Effect.gen(function* () {
		if (options.terms.length === 0) return refuse(FAILED, `${VERB}: no term given.`);

		const selected = selectRegisters(VERB, options.register, {allowed: true, refusal: ""});
		if (selected._tag === "Refused") return selected.outcome;

		const dir = yield* resolveDir(VERB, options.cwd, options.dir);
		if (dir._tag === "Refused") return dir.outcome;
		const files = registerFilesIn(dir.value, selected.value, yield* Path.Path);

		const corpus: Declared[] = [];
		const scope: string[] = [];
		for (const file of files) {
			const state = yield* readRegister(file, messages);
			if (state._tag === "Refused") return state.outcome;
			if (state.value._tag === "Absent") {
				scope.push(`${VERB}: ${file.display} — absent, contributing 0 row(s).`);
				continue;
			}
			for (const row of state.value.parsed.rows) corpus.push({row, register: file.name});
			scope.push(`${VERB}: ${file.display} — ${state.value.parsed.rows.length} row(s).`);
		}

		const resolutions = options.terms.map((term) => resolve(term, corpus));
		if (options.json) return answer(JSON.stringify(resolutions), scope);
		return answer(resolutions.map(renderLine).join("\n"), scope);
	});
