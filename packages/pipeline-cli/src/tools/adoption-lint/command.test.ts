import {execFile} from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, assert, beforeAll, describe, it} from "@effect/vitest";

// The fail-closed exit contract of `pipeline-cli adoption-lint check` over the shared bin.
const BIN = fileURLToPath(new URL("../../bin.ts", import.meta.url));
// Repo root: this file is packages/pipeline-cli/src/tools/adoption-lint/command.test.ts.
const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));

interface RunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

const run = (args: ReadonlyArray<string>): Promise<RunResult> =>
	new Promise((resolve) => {
		execFile("node", [BIN, "adoption-lint", ...args], (error, stdout, stderr) => {
			const code =
				error && typeof (error as {code?: unknown}).code === "number"
					? (error as {code: number}).code
					: 0;
			resolve({code, stdout, stderr});
		});
	});

// A full inline re-derivation of the seeded `verdict read` decision (all three tells),
// with no `pipeline-cli verdict` citation — the finding case.
const RE_DERIVATION = [
	'select(.body | test("review-(code|doc|skill): (PASS|FAIL)"))',
	"gh api repos/$REPO/collaborators/$a/permission",
	"jq 'sort_by(.created_at) | last'",
].join("\n");

// The full live corpus the adoption-lint.yml job scans: every .md/.sh under the plugin
// dir plus the orchestrator's drive-issue.js (the declared mirror).
const corpusFiles = (): string[] => {
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, {withFileTypes: true})) {
			const abs = join(dir, entry.name);
			if (statSync(abs).isDirectory()) walk(abs);
			else if (/\.(?:md|sh)$/.test(entry.name)) out.push(abs);
		}
	};
	walk(join(REPO_ROOT, "claude-plugins", "kampus-pipeline"));
	const orchestrator = join(REPO_ROOT, ".claude", "workflows", "drive-issue.js");
	if (existsSync(orchestrator)) out.push(orchestrator);
	return out;
};

describe("adoption-lint check — fail-closed exit contract (ADR 0092)", () => {
	let dir: string;
	const writeCorpus = (name: string, content: string): string => {
		const d = join(dir, "skills", name);
		mkdirSync(d, {recursive: true});
		const p = join(d, "SKILL.md");
		writeFileSync(p, content, "utf8");
		return p;
	};

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "adoption-lint-"));
	});
	afterAll(() => {
		rmSync(dir, {recursive: true, force: true});
	});

	it("exits 2 and reports the finding on an un-cited re-derivation", async () => {
		const f = writeCorpus("dirty", RE_DERIVATION);
		const {code, stdout, stderr} = await run(["check", f]);
		assert.strictEqual(code, 2);
		assert.include(stdout, "scanned 1 corpus file");
		assert.include(stderr, "inline re-derivation");
	}, 30_000);

	// The green-corpus assertion CI depends on: over the FULL live corpus (the exact set
	// the adoption-lint.yml job hands the tool), the seeded manifest is clean — every
	// re-derivation is either cited or covered by a valid declared exemption. This is what
	// lets the lint land green while armed against new drift; a migrated grandfather entry
	// or a new un-cited re-derivation would flip it to exit 2 here.
	it("exits 0 over the full live corpus (the CI scope)", async () => {
		const corpus = corpusFiles();
		assert.isAbove(corpus.length, 1, "expected a non-empty live corpus");
		const {code, stdout, stderr} = await run(["check", ...corpus]);
		assert.strictEqual(code, 0, `adoption-lint red on the live corpus:\n${stdout}\n${stderr}`);
		assert.include(stdout, "clean");
	}, 60_000);

	it("exits 3 (zero-scope FAIL) when every handed file is unreadable/missing", async () => {
		const {code, stderr} = await run(["check", join(dir, "does-not-exist.md")]);
		assert.strictEqual(code, 3);
		assert.include(stderr, "zero scope");
	}, 30_000);
});
