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
	it("claims before it writes layer one, so a defer cannot strip a live incumbent's assignment", () => {
		// scope: the writers whose procedure actually writes layer one (a surface that only
		// describes the claim has no ordering to pin). The write is `pipeline-cli claim assign`
		// since #4298 — the raw POST stays matchable so the pin survives an un-migrated corpus.
		// Fail closed on zero scope (ADR 0092).
		const LAYER_ONE_WRITE =
			/(?:gh api -X POST[^\n]*\/assignees|(?:pipeline-cli|"\$PCLI")\s+claim\s+assign\b)/;
		const selfAssigning = CLAIM_WRITERS.map((rel) => ({
			rel,
			content: readFileSync(join(REPO_ROOT, rel), "utf8"),
		})).filter(({content}) => LAYER_ONE_WRITE.test(content));
		assert.isAbove(selfAssigning.length, 0, "expected at least one self-assigning claim writer");

		for (const {rel, content} of selfAssigning) {
			// the verb INVOCATION (verb + its issue argument), not a prose mention of the verb —
			// a citation earlier in the file must not satisfy an ordering claim about the procedure.
			// The invocation resolves the shim through §CLI's `$PCLI`; the bare `pipeline-cli` form
			// stays matchable so this pin survives a corpus that has not yet been migrated (#3314).
			const claimAt = content.search(
				/(?:pipeline-cli|"\$PCLI")\s+tracker\s+claim\s+(?:<N>|\$\{issue\})/,
			);
			assert.isAbove(claimAt, -1, `${rel} must invoke the claim-write verb on the issue`);
			assert.isAbove(
				content.slice(claimAt).search(LAYER_ONE_WRITE),
				-1,
				`${rel} must write layer one AFTER it claims — assign-then-claim makes the defer path unassign the live incumbent (#4015)`,
			);
			// A layer-one write EARLIER in the file is the delegated branch, where the claim was won
			// before the spawn — safe only if that branch first proves the lane is ours. Ungated, it
			// is the same assign-then-claim hazard wearing a different hat.
			const before = content.slice(0, claimAt);
			if (LAYER_ONE_WRITE.test(before)) {
				assert.isBelow(
					before.search(/(?:pipeline-cli|"\$PCLI")\s+claim\s+is-mine\b/),
					before.search(LAYER_ONE_WRITE),
					`${rel} writes layer one before its own claim — that is only sound on the delegated path, where ownership must be proven first (#4298)`,
				);
			}
			assert.notMatch(
				content,
				/gh api -X DELETE[^\n]*\/assignees/,
				`${rel} must not unassign as claim cleanup — under the shared login that slot may be the incumbent's (#4015)`,
			);
		}
	});

	// #4298: layer one (the assignee) is the ONLY layer the write-code Step-1 picker reads, and the
	// delegated path wrote none — the orchestrated branch skips the direct-path block that carries
	// it, and the obligation survived only inside one orchestrator's prompt. Pin the two facts that
	// close it: every claim-writing surface routes layer one through the one verb, and write-code's
	// DELEGATED branch carries its own write rather than inheriting the direct path's.
	it("writes layer one through the one verb, and the delegated branch carries its own", () => {
		for (const rel of CLAIM_WRITERS) {
			assert.match(
				readFileSync(join(REPO_ROOT, rel), "utf8"),
				/(?:pipeline-cli|"\$PCLI")\s+claim\s+assign\b/,
				`${rel} must write the §7 layer-one availability gate through \`pipeline-cli claim assign\``,
			);
		}
		const skill = readFileSync(
			join(REPO_ROOT, "claude-plugins/kampus-pipeline/skills/write-code/SKILL.md"),
			"utf8",
		);
		const delegatedAt = skill.search(/^### Delegated claim/m);
		const directAt = skill.search(/^### Direct path/m);
		assert.isAbove(delegatedAt, -1, "write-code must keep its delegated-claim branch");
		assert.isAbove(directAt, delegatedAt, "write-code must keep its direct-path branch after it");
		assert.match(
			skill.slice(delegatedAt, directAt),
			/(?:pipeline-cli|"\$PCLI")\s+claim\s+assign\b/,
			"write-code's DELEGATED branch must write layer one itself — skipping it is what left an issue `status:triaged` + unassigned with its PR in review (#4298)",
		);
	});

	it("exits 3 (zero-scope FAIL) when every handed file is unreadable/missing", async () => {
		const {code, stderr} = await run(["check", join(dir, "does-not-exist.md")]);
		assert.strictEqual(code, 3);
		assert.include(stderr, "zero scope");
	});
});
