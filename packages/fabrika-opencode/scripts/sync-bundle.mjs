#!/usr/bin/env node
/**
 * The release-time bundle copy: the authored agent-shell mirrors and skills dir become
 * `dist/agents/` and `dist/skills/`, which `dist/index.js` reads by path off
 * `import.meta.url` (issue #6965). tsc emits nothing for either source, so without this
 * step the published tarball registers zero agents and zero skills.
 *
 * Sources are the repo's authored dirs — `.opencode/agent/` (the opencode mirror shells)
 * and `claude-plugins/fabrika/skills/` (the single authored skills dir) — read at build
 * time so a release can never ship a stale hand-bundled copy. The copy is total: every
 * file under a skill dir ships, because a SKILL.md may reference a sibling asset by
 * relative path and an exception list is where that reference silently breaks. Both
 * counts are printed so the release log records what shipped; every failure exits
 * non-zero.
 */
import {copyFileSync, existsSync, mkdirSync, readdirSync} from "node:fs";
import {join, relative, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = resolve(PACKAGE_ROOT, "../..");
const DIST = join(PACKAGE_ROOT, "dist");

const AGENT_SOURCE = join(REPO_ROOT, ".opencode", "agent");
const SKILLS_SOURCE = join(REPO_ROOT, "claude-plugins", "fabrika", "skills");
const AGENTS_TARGET = join(DIST, "agents");
const SKILLS_TARGET = join(DIST, "skills");

const walkFiles = (dir) =>
	readdirSync(dir, {recursive: true, withFileTypes: true})
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name));

for (const dir of [AGENT_SOURCE, SKILLS_SOURCE]) {
	if (!existsSync(dir)) {
		console.error(
			`sync-bundle: authored dir ${dir} does not exist — refusing to bundle an empty package`,
		);
		process.exit(1);
	}
}

mkdirSync(AGENTS_TARGET, {recursive: true});
const shells = walkFiles(AGENT_SOURCE)
	.filter((file) => file.endsWith(".md"))
	.sort();
if (shells.length === 0) {
	console.error(
		`sync-bundle: ${AGENT_SOURCE} carries no .md shell — refusing to bundle zero agents`,
	);
	process.exit(1);
}
for (const shell of shells) {
	const target = join(AGENTS_TARGET, relative(AGENT_SOURCE, shell));
	mkdirSync(resolve(target, ".."), {recursive: true});
	copyFileSync(shell, target);
}

mkdirSync(SKILLS_TARGET, {recursive: true});
const skills = readdirSync(SKILLS_SOURCE, {withFileTypes: true})
	.filter((entry) => entry.isDirectory() && existsSync(join(SKILLS_SOURCE, entry.name, "SKILL.md")))
	.map((entry) => entry.name)
	.sort();
if (skills.length === 0) {
	console.error(
		`sync-bundle: ${SKILLS_SOURCE} carries no SKILL.md dirs — refusing to bundle zero skills`,
	);
	process.exit(1);
}
let skillFiles = 0;
for (const skill of skills) {
	for (const file of walkFiles(join(SKILLS_SOURCE, skill))) {
		const target = join(SKILLS_TARGET, relative(SKILLS_SOURCE, file));
		mkdirSync(resolve(target, ".."), {recursive: true});
		copyFileSync(file, target);
		skillFiles += 1;
	}
}

console.log(
	`sync-bundle: bundled ${shells.length} agent shell(s) from .opencode/agent and ${skillFiles} file(s) across ${skills.length} skill(s) from claude-plugins/fabrika/skills`,
);
