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
const WORKFLOW_SKILLS = ["report", "triage", "build", "review", "ship"];
const SKILLS = readdirSync(SOURCE_ROOT)
	.filter((skill) => existsSync(join(SOURCE_ROOT, skill, "SKILL.md")))
	.sort();

rmSync(DEST_ROOT, {recursive: true, force: true});
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

const frontDoor = join(DEST_ROOT, "front-door", "SKILL.md");
const adaptedFrontDoor = readFileSync(frontDoor, "utf8")
	.replace("disable-model-invocation: true", "disable-model-invocation: false")
	.replace(
		"Human-typed only; the model cannot fire this.",
		"Invoke when the user requests the fabrika front door.",
	);
writeFileSync(frontDoor, adaptedFrontDoor);

for (const entry of ["agents", "docs", "guide", ".claude-plugin", "hooks.json"]) {
	cpSync(join(PLUGIN_SOURCE, entry), join(PLUGIN_ROOT, entry), {recursive: true});
}

console.log(
	`sync-bundle: bundled ${SKILLS.length} Codex-compatible skills; workflow core: ${WORKFLOW_SKILLS.join(", ")}`,
);
