#!/usr/bin/env node

import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import {join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = resolve(PLUGIN_ROOT, "../..");
const SOURCE_ROOT = join(REPO_ROOT, "claude-plugins", "fabrika", "skills");
const PLUGIN_SOURCE = join(REPO_ROOT, "claude-plugins", "fabrika");
const DEST_ROOT = join(PLUGIN_ROOT, "skills");
const REFERENCE_ROOT = join(PLUGIN_ROOT, "references");
const FRONT_DOOR = "front-door";
const WORKFLOW_SKILLS = ["report", "triage", "build", "review", "ship"];
const SKILLS = readdirSync(SOURCE_ROOT)
	.filter((skill) => skill !== FRONT_DOOR && existsSync(join(SOURCE_ROOT, skill, "SKILL.md")))
	.sort();

rmSync(DEST_ROOT, {recursive: true, force: true});
rmSync(REFERENCE_ROOT, {recursive: true, force: true});
for (const entry of ["agents", "docs", "guide", ".claude-plugin", "hooks.json"]) {
	rmSync(join(PLUGIN_ROOT, entry), {recursive: true, force: true});
}
mkdirSync(DEST_ROOT, {recursive: true});

for (const skill of SKILLS) {
	const source = join(SOURCE_ROOT, skill);
	if (!existsSync(join(source, "SKILL.md"))) {
		throw new Error(`sync-bundle: canonical skill is missing: ${skill}`);
	}
	cpSync(source, join(DEST_ROOT, skill), {recursive: true});
}

cpSync(join(SOURCE_ROOT, FRONT_DOOR), join(REFERENCE_ROOT, FRONT_DOOR), {recursive: true});

const adrSkill = join(DEST_ROOT, "adr", "SKILL.md");
const adrSource = readFileSync(adrSkill, "utf8");
const canonicalFrontDoorLink = "[front-door](../front-door/SKILL.md)";
if (!adrSource.includes(canonicalFrontDoorLink)) {
	throw new Error("sync-bundle: canonical ADR skill no longer has the expected front-door link");
}
writeFileSync(
	adrSkill,
	adrSource.replace(canonicalFrontDoorLink, "[front-door](../../references/front-door/SKILL.md)"),
);

for (const entry of ["agents", "docs", "guide", ".claude-plugin", "hooks.json"]) {
	cpSync(join(PLUGIN_SOURCE, entry), join(PLUGIN_ROOT, entry), {recursive: true});
}

console.log(
	`sync-bundle: bundled ${SKILLS.length} Codex-compatible skills; workflow core: ${WORKFLOW_SKILLS.join(", ")}`,
);
