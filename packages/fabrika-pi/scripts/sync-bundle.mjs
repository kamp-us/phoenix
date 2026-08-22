#!/usr/bin/env node
/**
 * Release-time bundle for @kampus/fabrika-pi (ADR 0332).
 *
 * Copies the single authored sources into `dist/` so the published package carries real copies and
 * the manifest keys (`pi.skills`, `pi.subagents.agents`) point at bundled paths:
 *
 *   claude-plugins/fabrika/skills/<skill>/…  →  dist/skills/<skill>/…
 *   .pi/agents/<shell>.md                    →  dist/agents/<shell>.md
 *
 * The single-source rule (#6985): nothing here is hand-maintained — authored content lives only in
 * `claude-plugins/fabrika/skills/` and `.pi/agents/`, and this script is the only thing that
 * produces the bundled copies. Editing anything under `dist/` by hand is lost on the next sync.
 *
 * Fail-closed, mirroring #6967's sync: a source tree that yields zero skills or zero agents is a
 * moved or emptied source, and bundling nothing would publish a package whose manifest points at
 * nothing — so the script refuses instead. The sync is total: `dist/` is removed and rebuilt on
 * every run, so running twice is idempotent and stale copies of deleted sources never survive.
 */
import {cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync} from "node:fs";
import {join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = resolve(PACKAGE_ROOT, "../..");

/** The authored sources, resolved off this script's own location — never off cwd. */
export const SOURCES = {
	skills: join(REPO_ROOT, "claude-plugins", "fabrika", "skills"),
	agents: join(REPO_ROOT, ".pi", "agents"),
};

/** Where the bundled copies land — the paths the manifest keys point at. */
export const DEST = join(PACKAGE_ROOT, "dist");

/**
 * Sync the bundle. Returns what shipped so the caller (and the summary line) can prove it was
 * something; throws when a source is empty, because an empty bundle must not ship.
 *
 * @param {{skills?: string, agents?: string, dest?: string}} [paths] overrides for tests.
 * @returns {{skills: string[], agents: string[]}} bundled names, sorted.
 */
export function syncBundle(paths = {}) {
	const skillsSource = paths.skills ?? SOURCES.skills;
	const agentsSource = paths.agents ?? SOURCES.agents;
	const dest = paths.dest ?? DEST;

	if (!existsSync(skillsSource)) {
		throw new Error(`sync-bundle: skills source is missing: ${skillsSource}`);
	}
	if (!existsSync(agentsSource)) {
		throw new Error(`sync-bundle: agents source is missing: ${agentsSource}`);
	}

	// A skill is a directory carrying its own SKILL.md — the same rule pi uses to discover one,
	// so a stray non-skill directory under the authored tree is skipped rather than shipped.
	const skills = readdirSync(skillsSource)
		.filter((name) => {
			const entry = join(skillsSource, name);
			return statSync(entry).isDirectory() && existsSync(join(entry, "SKILL.md"));
		})
		.sort();
	const agents = readdirSync(agentsSource)
		.filter((name) => name.endsWith(".md"))
		.sort();

	if (skills.length === 0) {
		throw new Error(
			`sync-bundle: refusing to bundle zero skills — no SKILL.md directory found under ${skillsSource}`,
		);
	}
	if (agents.length === 0) {
		throw new Error(
			`sync-bundle: refusing to bundle zero agent shells — no .md file found under ${agentsSource}`,
		);
	}

	rmSync(dest, {recursive: true, force: true});
	for (const skill of skills) {
		cpSync(join(skillsSource, skill), join(dest, "skills", skill), {recursive: true});
	}
	mkdirSync(join(dest, "agents"), {recursive: true});
	for (const agent of agents) {
		cpSync(join(agentsSource, agent), join(dest, "agents", agent));
	}

	return {skills, agents};
}

/** Print one line naming everything that shipped, so a green run says what it bundled. */
function report({skills, agents}) {
	console.log(
		`sync-bundle: bundled ${skills.length} skill${skills.length === 1 ? "" : "s"} (${skills.join(", ")}) ` +
			`and ${agents.length} agent shell${agents.length === 1 ? "" : "s"} (${agents.join(", ")}) → ${DEST}`,
	);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	report(syncBundle());
}
