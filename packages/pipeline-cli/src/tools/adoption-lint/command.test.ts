import {execFile} from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, assert, beforeAll, describe, it} from "@effect/vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../../test-budget.ts";

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

// The closed set of claim-marker writer surfaces — the procedure texts that post a `claim:`
// comment (#3987) and, on the self-assigning ones, order it against the assignee (#4015).
const CLAIM_WRITERS = [
	"claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md",
	"claude-plugins/kampus-pipeline/skills/write-code/SKILL.md",
	".claude/workflows/drive-issue.js",
];

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

describe("adoption-lint check — fail-closed exit contract (ADR 0092)", {
	timeout: SUBPROCESS_TEST_TIMEOUT_MS,
}, () => {
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
	});

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
	});

	// #3987: the corpus-side half of "every claim writer stamps presence". A writer that composes a
	// `claim:` body by hand skips the ADR-0191 stamp, and an unstamped marker is indeterminate
	// forever ⇒ supersession goes inert on that lane while the mechanism looks fixed. The declared
	// `tracker claim` decision reds a NEW such writer; this pins the three that already exist.
	it("every claim-marker writer cites `pipeline-cli tracker claim` and hand-composes no body", () => {
		for (const rel of CLAIM_WRITERS) {
			const content = readFileSync(join(REPO_ROOT, rel), "utf8");
			assert.match(
				content,
				/pipeline-cli\s+tracker\s+claim\b/,
				`${rel} must cite the claim-write verb`,
			);
			assert.notMatch(
				content,
				/body=["'`]?claim:/,
				`${rel} must not hand-compose a claim-marker body (it would skip the presence stamp)`,
			);
		}
	});

	// #4015: the occupied-lane scenario. An arriving agent that meets a LIVE incumbent must defer
	// AND leave the incumbent's assignment intact — but every agent authenticates as the same
	// login, so the assignee is ONE shared slot. Assign-then-claim gives the defer path no safe
	// back-off: the self-assign is a no-op (the slot already shows that login), the verb defers,
	// and the cleanup unassign then removes the INCUMBENT's assignment. Pin the only ordering that
	// makes that unrepresentable — claim first, assign only on the verb's exit 0, never unassign.
	it("claims before it self-assigns, so a defer cannot strip a live incumbent's assignment", () => {
		// scope: the writers whose procedure actually issues the self-assign (a surface that only
		// describes the claim has no ordering to pin). Fail closed on zero scope (ADR 0092).
		const selfAssigning = CLAIM_WRITERS.map((rel) => ({
			rel,
			content: readFileSync(join(REPO_ROOT, rel), "utf8"),
		})).filter(({content}) => /gh api -X POST[^\n]*\/assignees/.test(content));
		assert.isAbove(selfAssigning.length, 0, "expected at least one self-assigning claim writer");

		for (const {rel, content} of selfAssigning) {
			// the verb INVOCATION (verb + its issue argument), not a prose mention of the verb —
			// a citation earlier in the file must not satisfy an ordering claim about the procedure.
			// The invocation resolves the shim through §CLI's `$PCLI`; the bare `pipeline-cli` form
			// stays matchable so this pin survives a corpus that has not yet been migrated (#3314).
			const claimAt = content.search(
				/(?:pipeline-cli|"\$PCLI")\s+tracker\s+claim\s+(?:<N>|\$\{issue\})/,
			);
			const assignAt = content.search(/gh api -X POST[^\n]*\/assignees/);
			assert.isAbove(claimAt, -1, `${rel} must invoke the claim-write verb on the issue`);
			assert.isBelow(
				claimAt,
				assignAt,
				`${rel} must claim BEFORE it self-assigns — assign-then-claim makes the defer path unassign the live incumbent (#4015)`,
			);
			assert.notMatch(
				content,
				/gh api -X DELETE[^\n]*\/assignees/,
				`${rel} must not unassign as claim cleanup — under the shared login that slot may be the incumbent's (#4015)`,
			);
		}
	});

	it("exits 3 (zero-scope FAIL) when every handed file is unreadable/missing", async () => {
		const {code, stderr} = await run(["check", join(dir, "does-not-exist.md")]);
		assert.strictEqual(code, 3);
		assert.include(stderr, "zero scope");
	});
});
