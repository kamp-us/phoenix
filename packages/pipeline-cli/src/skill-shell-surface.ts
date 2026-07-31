/**
 * A skill's shell surface, for the parsers that slice a step's constants out of `SKILL.md` **by
 * markdown heading**. Epic #4435 phase 1 moves fenced shell into `<skill>/scripts/*.sh`, so a
 * heading slice of the markdown alone stops reaching the shell it parses — the parse resolves
 * nothing on a *pure relocation* (#4498).
 *
 * A section's surface is therefore its heading slice **plus the content of every `scripts/*.sh` the
 * slice sources**. Two deliberate choices:
 *
 * - **Slice first, then follow.** The section boundary is computed on the pristine markdown, so a
 *   script that emits markdown from a heredoc cannot truncate the section by carrying a `## ` line.
 *   Followed content is appended, which also keeps the prose-position parses (a numbered item and
 *   its continuation lines) byte-identical to the un-extracted corpus.
 * - **Sibling-scoped, not the whole plugin tree** — the same scoping `kp_skill_shell_surfaces`
 *   (`claude-plugins/kampus-pipeline/lib/common.sh`, #4470) and `adoption-lint`'s claim pins (#4449)
 *   chose: the shared shell is a library many skills call, so folding it into every caller's surface
 *   would let one shared half-procedure satisfy every skill's own rule.
 *
 * Fail-closed direction, unchanged from the parsers that consume this (ADR 0092 / §ZS): a heading
 * that matches nothing resolves to ZERO scanned files, and a sourced script that cannot be read is
 * reported `unresolved` rather than skipped. Both are UNKNOWN, never "the constant is absent" — the
 * caller turns either into its own fail-closed constant, and `scanned` is returned so a consumer can
 * assert what was actually read instead of trusting a green.
 */

import {existsSync, readFileSync} from "node:fs";
import {dirname, join} from "node:path";

/** Reads a `scripts/<name>.sh` beside the skill. `undefined` = UNRESOLVED, never "empty". */
export type ScriptReader = (scriptName: string) => string | undefined;

export interface SkillSurface {
	/** A repo-relative label for the markdown file, used in the emitted scanned scope. */
	readonly label: string;
	readonly text: string;
	readonly readScript: ScriptReader;
}

export interface ResolvedSection {
	/** The heading slice with every resolvable sourced script appended. `""` = heading unmatched. */
	readonly section: string;
	/** What was actually read: the markdown label, then each followed script. Empty = ZERO SCOPE. */
	readonly scanned: ReadonlyArray<string>;
	/** Scripts the section sources that did not read back — UNKNOWN, never absent. */
	readonly unresolved: ReadonlyArray<string>;
}

export const ZERO_SCOPE: ResolvedSection = {section: "", scanned: [], unresolved: []};

/**
 * The `scripts/*.sh` a stretch of skill text sources (`. "$<SKILL>_SCRIPTS/<name>.sh"`), in first
 * appearance order, deduplicated. Deliberately the SAME matcher `adoption-lint`'s claim pins use
 * (#4449) — three consumers answering "which script does this text source?" three ways would be its
 * own defect.
 */
export const sourcedScriptNames = (text: string): ReadonlyArray<string> => [
	...new Set([...text.matchAll(/_SCRIPTS\}?\/([\w.-]+\.sh)/g)].flatMap((m) => m[1] ?? [])),
];

/** Resolve one heading-sliced section into its full shell surface. */
export const resolveSection = (
	surface: SkillSurface,
	slice: (text: string) => string,
): ResolvedSection => {
	const sliced = slice(surface.text);
	if (sliced === "") return ZERO_SCOPE;
	const scanned = [surface.label];
	const unresolved: string[] = [];
	const parts = [sliced];
	for (const name of sourcedScriptNames(sliced)) {
		const content = surface.readScript(name);
		if (content === undefined || content === "") {
			unresolved.push(name);
			continue;
		}
		scanned.push(join("scripts", name));
		parts.push(content);
	}
	return {section: parts.join("\n"), scanned, unresolved};
};

/** A surface whose scripts come from disk, sibling-scoped to the skill's own `scripts/` dir. */
export const skillSurfaceFromDisk = (skillMdPath: string, label: string): SkillSurface => {
	const scriptsDir = join(dirname(skillMdPath), "scripts");
	return {
		label,
		text: readFileSync(skillMdPath, "utf8"),
		readScript: (name) => {
			const path = join(scriptsDir, name);
			return existsSync(path) ? readFileSync(path, "utf8") : undefined;
		},
	};
};

/** A surface built from strings — for fixtures, and for re-parsing a mutated corpus. */
export const skillSurfaceFromText = (
	text: string,
	scripts: Readonly<Record<string, string>> = {},
	label = "SKILL.md",
): SkillSurface => ({label, text, readScript: (name) => scripts[name]});
