/**
 * `glossary sections` — the live section names of a register.
 *
 * **There is no exit-0-with-empty-stdout path.** A register that is absent, or present with no
 * heading, prints `-\tbootstrap\t0`, because an answer that prints nothing is byte-identical to a
 * verb that never ran (interface convention rule 2).
 */
import {Effect, Path} from "effect";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {BAD_SECTIONS} from "./codes.ts";
import {
	type GlossaryEffect,
	type RegisterFile,
	readRegister,
	registerFilesIn,
	resolveDir,
	selectRegisters,
} from "./guards.ts";

const VERB = "glossary sections";

export interface SectionsOptions {
	readonly register: string;
	readonly dir: string;
	readonly json: boolean;
	readonly cwd: string;
}

interface SectionLine {
	readonly register: string;
	readonly section: string;
	readonly rows: number;
}

const BOOTSTRAP: SectionLine = {register: "-", section: "bootstrap", rows: 0};

const messages = {
	unreadable: (path: string, reason: string) =>
		`${VERB}: cannot read ${path}: ${reason} — the section list is UNKNOWN, never empty.`,
	malformed: (path: string, reason: string) =>
		`${VERB}: ${path} has no parseable term table (${reason}) — the section list is UNKNOWN.`,
};

const scopeLine = (file: RegisterFile, bytes: number, state: string): string =>
	`${VERB}: ${file.display} — ${bytes} byte(s), ${state}.`;

export const runSections = (options: SectionsOptions): GlossaryEffect<VerbOutcome> =>
	Effect.gen(function* () {
		const selected = selectRegisters(VERB, options.register, {allowed: true, refusal: ""});
		if (selected._tag === "Refused") return selected.outcome;

		const dir = yield* resolveDir(VERB, options.cwd, options.dir);
		if (dir._tag === "Refused") return dir.outcome;
		const files = registerFilesIn(dir.value, selected.value, yield* Path.Path);

		const lines: SectionLine[] = [];
		const scope: string[] = [];
		for (const file of files) {
			const state = yield* readRegister(file, messages);
			if (state._tag === "Refused") return state.outcome;
			if (state.value._tag === "Absent") {
				scope.push(scopeLine(file, 0, "absent"));
				lines.push(BOOTSTRAP);
				continue;
			}
			const {text, parsed} = state.value;
			scope.push(scopeLine(file, new TextEncoder().encode(text).length, "present"));
			if (parsed.headings === 0) {
				// Content the verb can see and cannot place under any section — distinct from a register
				// that simply has no sections yet, which is an adopting repo's day one.
				if (parsed.rows.length > 0) {
					return refuse(
						BAD_SECTIONS,
						`${VERB}: ${file.display} carries ${parsed.rows.length} table row(s) under no "## " heading — the section list is UNKNOWN.`,
						scope,
					);
				}
				lines.push(BOOTSTRAP);
				continue;
			}
			for (const section of parsed.sections) {
				lines.push({register: file.name, section: section.name, rows: section.rows.length});
			}
		}

		if (options.json) return answer(JSON.stringify(lines), scope);
		return answer(
			lines.map((line) => `${line.register}\t${line.section}\t${line.rows}`).join("\n"),
			scope,
		);
	});
