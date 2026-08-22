/**
 * Unit tests for the release-time bundle sync (`node --test scripts/`), kept dependency-free so the
 * package stays installable in isolation (#6985 — no `catalog:` strings may appear in its manifest).
 *
 * Every case runs against a throwaway fixture tree, never against the authored sources: the
 * fail-closed refusals must be provable without touching a source tree that is always full.
 */
import assert from "node:assert/strict";
import {mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {test} from "node:test";
import {syncBundle} from "./sync-bundle.mjs";

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
