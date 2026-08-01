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
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, assert, beforeAll, describe, it} from "@effect/vitest";
import {reachedScriptNames} from "../../skill-shell-surface.ts";
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

/**
 * The ordering pin's population, DECLARED rather than derived-and-trusted — exactly the files whose
 * procedure writes layer one today. `writerSurface` deliberately stops at the sibling `scripts/` dir
 * (see below), so extracting a write into `shared/scripts/**` drops that file out of the ordering
 * scope *silently* — the same silent-coverage-loss class (#4509) reproducing inside its own remedy,
 * and reachable today because this repo is actively moving fenced shell into `shared/scripts/`.
 * Pinning the membership makes the drop-out RED: a writer that leaves, or an undeclared one that
 * arrives, fails here and forces the surface (or this list) to be reconciled on purpose.
 */
const LAYER_ONE_WRITING_FILES = [
	"claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md",
	"claude-plugins/kampus-pipeline/skills/write-code/scripts/step3-delegated-claim.sh",
	"claude-plugins/kampus-pipeline/skills/write-code/scripts/step3-direct-claim.sh",
	".claude/workflows/drive-issue.js",
];

interface SurfaceFile {
	readonly rel: string;
	readonly content: string;
}

/**
 * A claim writer's SURFACE is its own text plus the shell that was extracted out of it into the
 * `scripts/*.sh` beside it (epic #4435 phase 1). Reading the named file alone silently drops a claim
 * site the moment an extraction moves one: both of write-code's `claim assign` calls left `SKILL.md`
 * for `scripts/step3-{delegated,direct}-claim.sh`, which reddened the layer-one pin on a pure
 * relocation and — worse — dropped the whole skill out of the ordering pin's scope while it stayed
 * green. Same shape #4470 named and #4448 fixed for `validate-gate-path-drift` and
 * `class-probe-consumers`; this is that widening for the claim pins.
 *
 * Sibling-scoped on purpose, NOT the whole plugin tree: `shared/scripts/` is a library many surfaces
 * call, so folding it into every caller's surface would assert one shared half-procedure against
 * every writer's own ordering rule. That boundary holds in one direction only, and the residual is
 * covered by declared membership, not by this function — see `LAYER_ONE_WRITING_FILES`.
 */
const writerSurface = (rel: string): ReadonlyArray<SurfaceFile> => {
	const scriptsRel = join(dirname(rel), "scripts");
	const scriptsAbs = join(REPO_ROOT, scriptsRel);
	const scripts = existsSync(scriptsAbs)
		? readdirSync(scriptsAbs)
				.filter((entry) => entry.endsWith(".sh"))
				.sort()
				.map((entry) => join(scriptsRel, entry))
		: [];
	return [rel, ...scripts].map((f) => ({
		rel: f,
		content: readFileSync(join(REPO_ROOT, f), "utf8"),
	}));
};

/**
 * The `scripts/*.sh` beside the skill that a stretch of procedure text reaches — sourced or
 * executed. The matcher is `reachedScriptNames`, imported rather than re-declared: this file used
 * to carry its own copy of the regex, and a copy is exactly how the shared matcher's ADR-0232
 * widening could have landed while the pin below kept reading the old shape (#4573).
 */
const reachedScripts = (text: string, rel: string): ReadonlyArray<SurfaceFile> =>
	reachedScriptNames(text)
		.map((name) => join(dirname(rel), "scripts", name))
		.filter((f) => existsSync(join(REPO_ROOT, f)))
		.map((f) => ({rel: f, content: readFileSync(join(REPO_ROOT, f), "utf8")}));

/**
 * §7 layer one — the assignee write, in two deliberately DIFFERENT vocabularies. Keep them apart:
 * collapsing them into one shared constant is what silently widened the #4298 one-verb pin (a
 * tidy-up hoist that let a hand-rolled assignees POST pass the very test that forbids it).
 * `LAYER_ONE_VERB` is the one sanctioned form, and is what the #4298 pin asserts. `ANY_WRITE` also
 * admits the raw POST so the #4015 *ordering* pin still populates over an un-migrated corpus — a
 * tolerance that belongs to a population predicate, never to the pin forbidding the raw form. It is
 * derived from the verb so it can only ever be the wider of the two.
 */
const LAYER_ONE_VERB = /(?:pipeline-cli|"\$PCLI")\s+claim\s+assign\b/;
const LAYER_ONE_ANY_WRITE = new RegExp(
	`(?:gh api -X POST[^\\n]*\\/assignees|${LAYER_ONE_VERB.source})`,
);
/**
 * The claim verb's INVOCATION (verb + its issue argument), not a prose mention of it — a citation
 * elsewhere in the file must not satisfy an ordering claim about the procedure. `$N` is the extracted
 * form: a moved block's `<N>` metavariable becomes the script's positional parameter (#4449).
 */
const CLAIM_INVOCATION =
	/(?:pipeline-cli|"\$PCLI")\s+tracker\s+claim\s+(?:<N>|\$\{issue\}|"?\$N"?)/;
const IS_MINE = /(?:pipeline-cli|"\$PCLI")\s+claim\s+is-mine\b/;

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
			const surface = writerSurface(rel);
			assert.match(
				surface.map(({content}) => content).join("\n"),
				/(?:pipeline-cli|"\$PCLI")\s+tracker\s+claim\b/,
				`${rel} (or the scripts/ shell extracted out of it) must cite the claim-write verb`,
			);
			for (const {rel: f, content} of surface) {
				assert.notMatch(
					content,
					/body=["'`]?claim:/,
					`${f} must not hand-compose a claim-marker body (it would skip the presence stamp)`,
				);
			}
		}
	});

	// #4015: the occupied-lane scenario. An arriving agent that meets a LIVE incumbent must defer
	// AND leave the incumbent's assignment intact — but every agent authenticates as the same
	// login, so the assignee is ONE shared slot. Assign-then-claim gives the defer path no safe
	// back-off: the self-assign is a no-op (the slot already shows that login), the verb defers,
	// and the cleanup unassign then removes the INCUMBENT's assignment. Pin the only ordering that
	// makes that unrepresentable — claim first, assign only on the verb's exit 0, never unassign.
	it("claims before it writes layer one, so a defer cannot strip a live incumbent's assignment", () => {
		// scope: across each writer's SURFACE, the files whose procedure actually writes layer one (a
		// file that only describes the claim has no ordering to pin). The write is `pipeline-cli claim
		// assign` since #4298 — the raw POST stays matchable so the pin survives an un-migrated corpus.
		// Fail closed on zero scope (ADR 0092).
		const surfaces = CLAIM_WRITERS.map((rel) => writerSurface(rel));
		const selfAssigning = surfaces.flat().filter(({content}) => LAYER_ONE_ANY_WRITE.test(content));
		assert.deepStrictEqual(
			selfAssigning.map(({rel}) => rel).sort(),
			[...LAYER_ONE_WRITING_FILES].sort(),
			"the ordering pin's population drifted from the declared one — a layer-one write left the scanned surface, or an undeclared one arrived. Reconcile deliberately; do not silently accept a smaller scope (also the ADR-0092 zero-scope guard for this pin)",
		);

		// The ordering is pinned PER FILE, because after the extraction one branch's whole procedure is
		// one file — concatenating a surface would let a `tracker claim` in the direct-path script
		// satisfy an ordering claim about the delegated one, which is a different procedure.
		for (const {rel, content} of selfAssigning) {
			const assignAt = content.search(LAYER_ONE_ANY_WRITE);
			const claimAt = content.search(CLAIM_INVOCATION);
			if (claimAt > -1) {
				assert.isAbove(
					assignAt,
					claimAt,
					`${rel} must write layer one AFTER it claims — assign-then-claim makes the defer path unassign the live incumbent (#4015)`,
				);
			} else {
				// A layer-one write with no claim of its own is the DELEGATED branch, where the claim was
				// won before the spawn — safe only if that branch first proves the lane is ours. Ungated,
				// it is the same assign-then-claim hazard wearing a different hat.
				const isMineAt = content.search(IS_MINE);
				assert.isAbove(
					isMineAt,
					-1,
					`${rel} writes layer one without claiming — sound only on the delegated path, which must first prove the lane is ours (#4298)`,
				);
				assert.isBelow(
					isMineAt,
					assignAt,
					`${rel} writes layer one before it proves the lane is ours (#4298)`,
				);
			}
		}
		// …and each writer's surface must still claim SOMEWHERE, so a surface that only ever assigns
		// cannot pass by having every file take the delegated branch.
		for (const surface of surfaces) {
			if (!surface.some(({content}) => LAYER_ONE_ANY_WRITE.test(content))) continue;
			assert.isTrue(
				surface.some(({content}) => CLAIM_INVOCATION.test(content)),
				`${surface[0]?.rel} must invoke the claim-write verb on the issue`,
			);
		}
		for (const {rel, content} of surfaces.flat()) {
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
				writerSurface(rel)
					.map(({content}) => content)
					.join("\n"),
				LAYER_ONE_VERB,
				`${rel} (or the scripts/ shell extracted out of it) must write the §7 layer-one availability gate through \`pipeline-cli claim assign\``,
			);
		}
		const skillRel = "claude-plugins/kampus-pipeline/skills/write-code/SKILL.md";
		const skill = readFileSync(join(REPO_ROOT, skillRel), "utf8");
		const delegatedAt = skill.search(/^### Delegated claim/m);
		const directAt = skill.search(/^### Direct path/m);
		assert.isAbove(delegatedAt, -1, "write-code must keep its delegated-claim branch");
		assert.isAbove(directAt, delegatedAt, "write-code must keep its direct-path branch after it");
		const delegated = skill.slice(delegatedAt, directAt);
		if (!LAYER_ONE_VERB.test(delegated)) {
			// The branch's write now lives in the script the branch invokes, so follow the invocation
			// into it — sourced or executed, since which shape a step uses says nothing about where it
			// writes. Fail closed when the slice resolves to no script at all (ADR 0092): a heading pair
			// that reaches nothing is a broken scan, not a branch that passes.
			const followed = reachedScripts(delegated, skillRel);
			assert.isAbove(
				followed.length,
				0,
				"write-code's DELEGATED branch neither writes layer one inline nor reaches a resolvable script",
			);
			assert.isTrue(
				followed.some(({content}) => LAYER_ONE_VERB.test(content)),
				"write-code's DELEGATED branch must write layer one itself — skipping it is what left an issue `status:triaged` + unassigned with its PR in review (#4298)",
			);
		}
	});

	it("exits 3 (zero-scope FAIL) when every handed file is unreadable/missing", async () => {
		const {code, stderr} = await run(["check", join(dir, "does-not-exist.md")]);
		assert.strictEqual(code, 3);
		assert.include(stderr, "zero scope");
	});
});
