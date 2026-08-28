/**
 * Unit tests for the release-time bundle sync (`node --test scripts/`), kept dependency-free so the
 * package stays installable in isolation (#6985 — no `catalog:` strings may appear in its manifest).
 *
 * The sync mechanics run against throwaway fixture trees. The packaged-agent regression copies the
 * authored shells into a throwaway package so it exercises the same manifest boundary consumers do.
 */
import assert from "node:assert/strict";
import {
	copyFileSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {test} from "node:test";
import {fileURLToPath} from "node:url";
import {SOURCES, syncBundle} from "./sync-bundle.mjs";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "../..");

function readAgentFrontmatter(filePath) {
	const content = readFileSync(filePath, "utf8");
	const match = /^---\n([\s\S]*?)\n---\n/.exec(content);
	assert.ok(match, `${filePath} must carry frontmatter`);
	return Object.fromEntries(
		match[1].split("\n").map((line) => {
			const separator = line.indexOf(":");
			assert.notEqual(separator, -1, `${filePath} has malformed frontmatter: ${line}`);
			return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
		}),
	);
}

function resolvePackagedAgents(packageRoot) {
	const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
	const agentDirs = manifest.pi?.subagents?.agents;
	assert.ok(
		Array.isArray(agentDirs) && agentDirs.length > 0,
		"package must expose agent directories",
	);

	const agents = new Map();
	for (const relativeDir of agentDirs) {
		const dir = resolve(packageRoot, relativeDir);
		for (const file of readdirSync(dir)
			.filter((name) => name.endsWith(".md"))
			.sort()) {
			const frontmatter = readAgentFrontmatter(join(dir, file));
			agents.set(frontmatter.name, {
				inheritProjectContext: frontmatter.inheritProjectContext === "true",
				skills: frontmatter.skills.split(",").map((skill) => skill.trim()),
			});
		}
	}
	return agents;
}

/** One temp dir holding both fixture sources and the destination. */
function fixture({skills = 2, agents = 3} = {}) {
	const root = mkdtempSync(join(process.cwd(), "sync-bundle-fixture-"));
	const paths = {
		skills: join(root, "authored-skills"),
		agents: join(root, "authored-agents"),
		dest: join(root, "dist"),
	};
	for (let i = 0; i < skills; i++) {
		const skill = join(paths.skills, `skill-${i}`);
		mkdirSync(skill, {recursive: true});
		writeFileSync(join(skill, "SKILL.md"), `# skill ${i}\n`);
	}
	for (let i = 0; i < agents; i++) {
		mkdirSync(paths.agents, {recursive: true});
		writeFileSync(join(paths.agents, `shell-${i}.md`), `---\nname: shell-${i}\n---\nbody\n`);
	}
	// Both source directories must exist even when empty, so the zero-count refusals — not the
	// missing-source refusals — are what these fixtures prove.
	mkdirSync(paths.skills, {recursive: true});
	mkdirSync(paths.agents, {recursive: true});
	// A directory with no SKILL.md under the skills tree is not a skill — it must not ship.
	if (skills > 0) {
		mkdirSync(join(paths.skills, "not-a-skill"), {recursive: true});
		writeFileSync(join(paths.skills, "not-a-skill", "README.md"), "stray\n");
	}
	return {root, paths};
}

test("bundles every SKILL.md directory and every agent shell", () => {
	const fx = fixture();
	try {
		const shipped = syncBundle(fx.paths);
		assert.deepEqual(shipped.skills, ["skill-0", "skill-1"]);
		assert.deepEqual(shipped.agents, ["shell-0.md", "shell-1.md", "shell-2.md"]);
		const bundledSkills = readdirSync(join(fx.paths.dest, "skills")).sort();
		assert.deepEqual(
			bundledSkills,
			["skill-0", "skill-1"],
			"non-skill directories must not bundle",
		);
		assert.equal(
			readFileSync(join(fx.paths.dest, "skills", "skill-1", "SKILL.md"), "utf8"),
			"# skill 1\n",
		);
		assert.equal(
			readFileSync(join(fx.paths.dest, "agents", "shell-0.md"), "utf8"),
			"---\nname: shell-0\n---\nbody\n",
		);
	} finally {
		rmSync(fx.root, {recursive: true, force: true});
	}
});

test("packaged builder and reviewer inherit the canonical project contract and keep their skills", () => {
	const fx = fixture({skills: 1, agents: 0});
	try {
		copyFileSync(join(PACKAGE_ROOT, "package.json"), join(fx.root, "package.json"));
		syncBundle({...fx.paths, agents: SOURCES.agents});
		const agents = resolvePackagedAgents(fx.root);
		assert.deepEqual(agents.get("builder"), {
			inheritProjectContext: true,
			skills: ["build"],
		});
		assert.deepEqual(agents.get("reviewer"), {
			inheritProjectContext: true,
			skills: ["review"],
		});

		const agentsLink = join(REPO_ROOT, "AGENTS.md");
		assert.ok(lstatSync(agentsLink).isSymbolicLink(), "AGENTS.md must be a symlink");
		assert.equal(readlinkSync(agentsLink), "CLAUDE.md");
		assert.equal(
			readFileSync(agentsLink, "utf8"),
			readFileSync(join(REPO_ROOT, "CLAUDE.md"), "utf8"),
			"the inherited AGENTS.md contract must resolve to canonical CLAUDE.md contents",
		);
	} finally {
		rmSync(fx.root, {recursive: true, force: true});
	}
});

test("every packaged shell explicitly inherits context without changing its skill preload", () => {
	const fx = fixture({skills: 1, agents: 0});
	try {
		copyFileSync(join(PACKAGE_ROOT, "package.json"), join(fx.root, "package.json"));
		syncBundle({...fx.paths, agents: SOURCES.agents});
		const agents = resolvePackagedAgents(fx.root);
		assert.deepEqual(Object.fromEntries(agents), {
			builder: {inheritProjectContext: true, skills: ["build"]},
			"mixed-builder": {inheritProjectContext: true, skills: ["build", "build-ui"]},
			operator: {inheritProjectContext: true, skills: ["operate"]},
			reviewer: {inheritProjectContext: true, skills: ["review"]},
			shipper: {inheritProjectContext: true, skills: ["ship"]},
			triager: {inheritProjectContext: true, skills: ["triage"]},
			"ui-builder": {inheritProjectContext: true, skills: ["build-ui"]},
			"ui-reviewer": {inheritProjectContext: true, skills: ["review-ui"]},
		});
	} finally {
		rmSync(fx.root, {recursive: true, force: true});
	}
});

test("running twice is idempotent — same files, no stale copies", () => {
	const fx = fixture();
	try {
		const first = syncBundle(fx.paths);
		const snapshot = () => readdirSync(fx.paths.dest, {recursive: true}).sort().join("\n");
		const before = snapshot();
		const second = syncBundle(fx.paths);
		assert.deepEqual(second, first);
		assert.equal(snapshot(), before);
		// A source deleted between runs must not survive as a stale copy.
		rmSync(join(fx.paths.agents, "shell-2.md"));
		syncBundle(fx.paths);
		assert.deepEqual(readdirSync(join(fx.paths.dest, "agents")).sort(), [
			"shell-0.md",
			"shell-1.md",
		]);
	} finally {
		rmSync(fx.root, {recursive: true, force: true});
	}
});

test("refuses to bundle zero skills — fail-closed like #6967's sync", () => {
	const fx = fixture({skills: 0, agents: 1});
	try {
		assert.throws(() => syncBundle(fx.paths), /refusing to bundle zero skills/);
	} finally {
		rmSync(fx.root, {recursive: true, force: true});
	}
});

test("refuses to bundle zero agent shells", () => {
	const fx = fixture({skills: 1, agents: 0});
	try {
		assert.throws(() => syncBundle(fx.paths), /refusing to bundle zero agent shells/);
	} finally {
		rmSync(fx.root, {recursive: true, force: true});
	}
});
