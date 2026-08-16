import {assert, describe, it} from "@effect/vitest";
import {
	attribute,
	isUsableBaseline,
	isZeroScope,
	parseBaseline,
	scanCorpus,
	scanFile,
} from "./cli-invocation-guard.ts";

const TICKS = "```";
const fence = (lang: string, ...lines: ReadonlyArray<string>): string =>
	[`${TICKS}${lang}`, ...lines, TICKS].join("\n");

describe("cli-invocation-guard core", () => {
	it("flags a bare invocation inside a runnable bash fence", () => {
		const {findings} = scanFile("s.md", fence("bash", 'pipeline-cli leak-guard scan-pr "$PR"'));
		assert.strictEqual(findings.length, 1);
		assert.strictEqual(findings[0]?.line, 2);
		assert.include(findings[0]?.text ?? "", "leak-guard");
	});

	it("flags a bare invocation in a pipe, a substitution, and a conditional", () => {
		const {findings} = scanFile(
			"s.md",
			fence(
				"bash",
				'printf "%s" "$F" | pipeline-cli cp-classify classify --repo "$REPO"',
				'STATE="$(pipeline-cli merge-queue-classify classify --pr "$PR")"',
				"if ! pipeline-cli tracker claim 42; then exit 0; fi",
			),
		);
		assert.strictEqual(findings.length, 3);
	});

	it("accepts the §CLI canonical form — a resolved $PCLI path", () => {
		const {findings} = scanFile(
			"s.md",
			fence(
				"bash",
				// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion in a §CLI-preamble fixture, not a JS template
				'PCLI="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel)/claude-plugins/kampus-pipeline}/bin/pipeline-cli"',
				'"$PCLI" claim is-mine --issue 42 --session "$MY_CLAIM"',
			),
		);
		assert.deepStrictEqual(findings, []);
	});

	it("accepts an explicit shim path and the pinned package spec", () => {
		const {findings} = scanFile(
			"s.md",
			fence(
				"bash",
				"claude-plugins/kampus-pipeline/bin/pipeline-cli claim status --issue 1",
				"pnpm dlx @kampus/pipeline-cli@0.1.0 version",
			),
		);
		assert.deepStrictEqual(findings, []);
	});

	// #4236: the cwd-relative entrypoint form resolves only from the repo root. Everywhere else it
	// exits 1 with empty stdout — indistinguishable from the clean answer `guard-content-probe`,
	// `intake-dedup` and `split-guard` call sites consume, so the miss reads as a permissive verdict.
	it("flags the cwd-relative `node …/src/bin.ts` entrypoint form", () => {
		const {findings} = scanFile(
			"s.md",
			fence("bash", "node packages/pipeline-cli/src/bin.ts verdict read --pr 1"),
		);
		assert.strictEqual(findings.length, 1);
		assert.strictEqual(findings[0]?.line, 2);
		assert.include(findings[0]?.text ?? "", "verdict read");
	});

	it("flags the entrypoint form in a pipe, a substitution, and a conditional", () => {
		const {findings} = scanFile(
			"s.md",
			fence(
				"bash",
				"git diff --name-only origin/main... | node packages/pipeline-cli/src/bin.ts cp-classify classify",
				'EXISTING=$(node packages/pipeline-cli/src/bin.ts split-guard check --parent 1 --title "t")',
				"if ! node packages/pipeline-cli/src/bin.ts epic-splice apply; then break; fi",
			),
		);
		assert.strictEqual(findings.length, 3);
	});

	it("flags the entrypoint form at any leading path prefix, absolute or nested", () => {
		const {findings} = scanFile(
			"s.md",
			fence(
				"bash",
				"node ../../packages/pipeline-cli/src/bin.ts version",
				'node "$REPO_ROOT"/packages/pipeline-cli/src/bin.ts version',
			),
		);
		assert.strictEqual(findings.length, 2);
	});

	it("does not flag the entrypoint form in prose or a comment-only line", () => {
		const {findings} = scanFile(
			"s.md",
			"Historically skills ran `node packages/pipeline-cli/src/bin.ts <verb>`.\n" +
				fence("bash", "# was: node packages/pipeline-cli/src/bin.ts intake-dedup check", "true"),
		);
		assert.deepStrictEqual(findings, []);
	});

	it("ignores prose outside any fence — naming a verb is not invoking it", () => {
		const {findings} = scanFile(
			"s.md",
			"Run `pipeline-cli commands compact` for the tool map.\n" +
				fence("bash", 'echo "nothing to see"'),
		);
		assert.deepStrictEqual(findings, []);
	});

	it("ignores a non-runnable fence (text, json, markdown)", () => {
		const {findings} = scanFile("s.md", fence("text", "pipeline-cli claim release --issue 1"));
		assert.deepStrictEqual(findings, []);
	});

	it("ignores a comment-only line inside a runnable fence", () => {
		const {findings} = scanFile(
			"s.md",
			fence("bash", "# resolved via pipeline-cli verdict read — see §CLI", "true"),
		);
		assert.deepStrictEqual(findings, []);
	});

	it("resumes scanning after a fence closes, and after a non-runnable fence", () => {
		const content = [
			fence("json", '{"a": 1}'),
			fence("bash", "pipeline-cli version"),
			"prose",
			fence("bash", "true"),
		].join("\n");
		const {findings, fences} = scanFile("s.md", content);
		assert.strictEqual(fences, 2);
		assert.strictEqual(findings.length, 1);
	});

	it("flags a bare invocation as the last token on a line", () => {
		const {findings} = scanFile("s.md", fence("bash", "pipeline-cli"));
		assert.strictEqual(findings.length, 1);
	});

	it("sees through a blockquoted fence — a `> ` aside is copied and run like any other", () => {
		const content = [
			"> ```bash",
			"> pipeline-cli claim release --issue 1",
			"> # a quoted comment is still a comment",
			"> ```",
		].join("\n");
		const {findings, fences} = scanFile("s.md", content);
		assert.strictEqual(fences, 1);
		assert.strictEqual(findings.length, 1);
		assert.strictEqual(findings[0]?.line, 2);
	});

	it("scanCorpus reports every scope axis and aggregates findings", () => {
		const result = scanCorpus([
			{file: "a.md", content: fence("bash", "pipeline-cli version")},
			{file: "b.md", content: fence("bash", "true")},
			{file: "c.sh", content: "true\n"},
		]);
		assert.deepStrictEqual(result.scanned, ["a.md", "b.md", "c.sh"]);
		assert.strictEqual(result.fenceCount, 2);
		assert.strictEqual(result.shellFileCount, 1);
		assert.strictEqual(result.findings.length, 1);
		assert.isFalse(isZeroScope(result));
	});

	// #4486: a `.sh` file is one implicit runnable fence. Without this the whole shell surface
	// contributes zero scannable lines, so every extraction of fenced shell into `scripts/*.sh`
	// silently narrows the guard while it keeps exiting 0.
	describe("the shell surface — a `.sh` file is one implicit runnable fence (#4486)", () => {
		it("flags a bare invocation in a `.sh` file with no fence at all", () => {
			const {findings, fences} = scanFile(
				"skills/report/scripts/footer.sh",
				["#!/usr/bin/env bash", "set -euo pipefail", "pipeline-cli claim status --issue 42"].join(
					"\n",
				),
			);
			assert.strictEqual(fences, 1);
			assert.strictEqual(findings.length, 1);
			assert.strictEqual(findings[0]?.line, 3);
			assert.include(findings[0]?.text ?? "", "claim status");
		});

		it("flags the cwd-relative `node …/src/bin.ts` form in a `.sh` file", () => {
			const {findings} = scanFile(
				"skills/ship-it/scripts/step2.sh",
				"node packages/pipeline-cli/src/bin.ts verdict read --pr 1\n",
			);
			assert.strictEqual(findings.length, 1);
		});

		it("accepts the §CLI canonical form in a `.sh` file", () => {
			const {findings} = scanFile(
				"lib/common.sh",
				[
					// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion in a §CLI-preamble fixture, not a JS template
					'PCLI="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel)/claude-plugins/kampus-pipeline}/bin/pipeline-cli"',
					'"$PCLI" claim is-mine --issue 42',
				].join("\n"),
			);
			assert.deepStrictEqual(findings, []);
		});

		it("still ignores a comment-only line in a `.sh` file", () => {
			const {findings} = scanFile(
				"skills/doctor/doctor.sh",
				"# never call pipeline-cli bare — see §CLI\ntrue\n",
			);
			assert.deepStrictEqual(findings, []);
		});

		// The deliberate divergence from markdown: the extracted gate scripts emit markdown from
		// heredocs, so honouring a fence delimiter would close the implicit fence and blind
		// everything after it — the exact silent hole this widening closes.
		it("does not let a fence delimiter inside a `.sh` file close the implicit fence", () => {
			const {findings} = scanFile(
				"skills/review-code/scripts/verdict.sh",
				[
					"cat <<'EOF'",
					"```bash",
					"an illustrative block inside a heredoc",
					"```",
					"EOF",
					"pipeline-cli verdict write --pr 1",
				].join("\n"),
			);
			assert.strictEqual(findings.length, 1);
			assert.strictEqual(findings[0]?.line, 6);
		});
	});

	it("fails closed on zero scope PER SURFACE — no file, no `.md` fence, or no `.sh` file (ADR 0092, #4486)", () => {
		assert.isTrue(isZeroScope(scanCorpus([])));
		assert.isTrue(
			isZeroScope(scanCorpus([{file: "a.md", content: "prose only, no fence at all"}])),
		);
		// The load-bearing per-surface case: a healthy markdown surface must NOT satisfy the floor
		// on behalf of a shell surface that contributed nothing (a `.sh` leg of the corpus `find`
		// that silently matched no file).
		assert.isTrue(isZeroScope(scanCorpus([{file: "a.md", content: fence("bash", "true")}])));
		// …and the mirror: shell files present, markdown surface collapsed.
		assert.isTrue(isZeroScope(scanCorpus([{file: "a.sh", content: "true\n"}])));
	});
});

// #5679: `fabrika` IS on PATH, so a bare call resolves whichever copy PATH names. In a worktree
// that copy belongs to another checkout, and the delegation refuses it at exit 126 rather than
// answer from a tree the caller is not standing in — so every bare fence dies on step one.
describe("the fabrika surface — a bare `fabrika` is not the canonical form (#5679)", () => {
	it("flags a bare `fabrika` at the start of a runnable line", () => {
		const {findings} = scanFile("s.md", fence("bash", "fabrika build tree --require-clean"));
		assert.strictEqual(findings.length, 1);
		assert.strictEqual(findings[0]?.line, 2);
		assert.strictEqual(findings[0]?.cli, "fabrika");
	});

	it("flags a bare `fabrika` in a pipe, a substitution, a conditional and an env prefix", () => {
		const {findings} = scanFile(
			"s.md",
			fence(
				"bash",
				"fabrika build print 5679 | gh issue comment 5679 --body-file -",
				'STATE="$(fabrika build confirm 5679)"',
				"if ! fabrika build claim 5679; then exit 0; fi",
				"FABRIKA_DEBUG=1 fabrika build tree",
			),
		);
		assert.strictEqual(findings.length, 4);
		assert.deepStrictEqual(new Set(findings.map((f) => f.cli)), new Set(["fabrika"]));
	});

	it("accepts the canonical `pnpm exec fabrika` form", () => {
		const {findings} = scanFile(
			"s.md",
			fence(
				"bash",
				"pnpm exec fabrika build tree --require-clean",
				'STATE="$(pnpm exec fabrika build confirm 5679)"',
			),
		);
		assert.deepStrictEqual(findings, []);
	});

	// The reason this rule anchors on command position while the `pipeline-cli` rule does not:
	// `fabrika` is also a label, a directory, a marketplace entry and a plugin namespace, and all
	// four appear as ARGUMENTS in runnable fences. Flagging those would make the guard unusable.
	it("does not flag `fabrika` in argument position — a label, a path, a namespace", () => {
		const {findings} = scanFile(
			"s.md",
			fence(
				"bash",
				"gh issue edit 5679 --add-label fabrika",
				"ls claude-plugins/fabrika/skills/",
				"cat .fabrika/lanes/5679/events.jsonl",
				'gh pr list --search "fabrika in:title"',
			),
		);
		assert.deepStrictEqual(findings, []);
	});

	it("flags the cwd-relative `node …/fabrika-cli/src/bin.ts` entrypoint form", () => {
		const {findings} = scanFile(
			"s.md",
			fence("bash", "node packages/fabrika-cli/src/bin.ts lane status 5539"),
		);
		assert.strictEqual(findings.length, 1);
		assert.strictEqual(findings[0]?.cli, "fabrika");
	});

	it("ignores a named verb in prose and a commented-out call", () => {
		const {findings} = scanFile(
			"s.md",
			"Run `fabrika build pick` to take the next issue.\n" +
				fence("bash", "# was: fabrika build claim 5679", "true"),
		);
		assert.deepStrictEqual(findings, []);
	});

	it("flags a bare `fabrika` in a `.sh` file, which is one implicit fence", () => {
		const {findings} = scanFile("skills/build/scripts/claim.sh", "fabrika build claim 5679\n");
		assert.strictEqual(findings.length, 1);
		assert.strictEqual(findings[0]?.cli, "fabrika");
	});
});

describe("cli-invocation-guard attribution (#4250)", () => {
	const OFFENDER = "pipeline-cli claim status --issue 1";

	it("reproduces the #4229 shape — base carries the violation, head introduces none", () => {
		// The `main` tree that PR #4229 was merged against already carried the offender; the PR's own
		// files were clean. The corpus scan (the `push: main` leg) must still red, and the attributed
		// verdict (the `pull_request` leg) must be green.
		const offenderFile = {file: "crew/em.md", content: fence("bash", OFFENDER)};
		const base = scanCorpus([offenderFile, {file: "skills/a.md", content: fence("bash", "true")}]);
		const head = scanCorpus([
			offenderFile,
			{file: "skills/a.md", content: fence("bash", "echo edited-by-this-pr")},
		]);

		assert.strictEqual(head.findings.length, 1, "the main leg still reds on the dirty corpus");
		const attributed = attribute(head.findings, base.findings);
		assert.deepStrictEqual(
			attributed.map((f) => f.attribution),
			["pre-existing"],
			"the PR leg attributes the sole violation to the base, not to this head",
		);
	});

	it("still catches a violation this head introduced, in a file the base never had", () => {
		const base = scanCorpus([{file: "skills/a.md", content: fence("bash", "true")}]);
		const head = scanCorpus([
			{file: "skills/a.md", content: fence("bash", "true")},
			{file: "skills/new.md", content: fence("bash", OFFENDER)},
		]);
		const attributed = attribute(head.findings, base.findings);
		assert.deepStrictEqual(
			attributed.map((f) => f.attribution),
			["new"],
		);
	});

	it("still catches a violation added to a file that was ALREADY dirty (multiset, not set)", () => {
		// The loosening that would make the guard useless: exempting a file because it was dirty at
		// the base. A second offending line in the same file is this head's, and must red.
		const base = scanCorpus([{file: "skills/a.md", content: fence("bash", OFFENDER)}]);
		const head = scanCorpus([
			{file: "skills/a.md", content: fence("bash", OFFENDER, "pipeline-cli verdict read --pr 1")},
		]);
		const attributed = attribute(head.findings, base.findings);
		assert.deepStrictEqual(
			attributed.map((f) => f.attribution),
			["pre-existing", "new"],
		);
	});

	it("still catches a duplicated offending line — two copies of what the base had once", () => {
		const base = scanCorpus([{file: "skills/a.md", content: fence("bash", OFFENDER)}]);
		const head = scanCorpus([{file: "skills/a.md", content: fence("bash", OFFENDER, OFFENDER)}]);
		assert.strictEqual(
			attribute(head.findings, base.findings).filter((f) => f.attribution === "new").length,
			1,
		);
	});

	it("ignores a line-number shift — an unrelated edit above is not a new violation", () => {
		const base = scanCorpus([{file: "skills/a.md", content: fence("bash", OFFENDER)}]);
		const head = scanCorpus([
			{file: "skills/a.md", content: `prose added above\n\n${fence("bash", OFFENDER)}`},
		]);
		assert.notStrictEqual(head.findings[0]?.line, base.findings[0]?.line);
		assert.deepStrictEqual(
			attribute(head.findings, base.findings).map((f) => f.attribution),
			["pre-existing"],
		);
	});

	it("attributes a violation MOVED into another file — the strict direction", () => {
		const base = scanCorpus([{file: "skills/a.md", content: fence("bash", OFFENDER)}]);
		const head = scanCorpus([{file: "skills/b.md", content: fence("bash", OFFENDER)}]);
		assert.deepStrictEqual(
			attribute(head.findings, base.findings).map((f) => f.attribution),
			["new"],
		);
	});

	it("with an empty baseline every violation is attributable (the push: main leg)", () => {
		const head = scanCorpus([{file: "skills/a.md", content: fence("bash", OFFENDER)}]);
		assert.deepStrictEqual(
			attribute(head.findings, []).map((f) => f.attribution),
			["new"],
		);
	});

	it("rejects a zero-scope baseline — a broken base scan is never 'nothing pre-existing'", () => {
		const shellFile = {file: "a.sh", content: "true\n"};
		assert.isFalse(isUsableBaseline(scanCorpus([])));
		assert.isFalse(isUsableBaseline(scanCorpus([{file: "a.md", content: "prose, no fence"}])));
		// Per surface (#4486): a base enumerated over `.md` only is a NARROWER corpus than the head
		// scan, so its silent-on-shell manifest must not read as "nothing pre-existing there".
		assert.isFalse(isUsableBaseline(scanCorpus([{file: "a.md", content: fence("bash", "true")}])));
		assert.isFalse(isUsableBaseline(scanCorpus([shellFile])));
		assert.isTrue(
			isUsableBaseline(scanCorpus([{file: "a.md", content: fence("bash", "true")}, shellFile])),
		);
	});

	describe("parseBaseline — a manifest missing a scope axis is unusable, not zero", () => {
		const wellFormed = {findings: [], scanned: ["a.md"], fenceCount: 1, shellFileCount: 1};

		it("round-trips a well-formed manifest", () => {
			assert.deepStrictEqual(parseBaseline(JSON.stringify(wellFormed)), wellFormed);
		});

		it("rejects a manifest with no `shellFileCount` — the fail-OPEN direction (#4486)", () => {
			// A base-side `baseline` from a build predating the `.sh` surface omits the field. Absent,
			// it reads back `undefined`, and `undefined === 0` is false — so `isZeroScope` would call a
			// zero-shell-scope baseline USABLE. Only reachable under version skew between the two
			// steps, but it is the wrong direction to fail in, so the parser refuses it outright.
			const {shellFileCount: _dropped, ...legacy} = wellFormed;
			assert.isNull(parseBaseline(JSON.stringify(legacy)));
		});

		it("rejects unparseable JSON, a non-object, and a wrong-shaped manifest", () => {
			assert.isNull(parseBaseline("{not json"));
			assert.isNull(parseBaseline("[]"));
			assert.isNull(parseBaseline(JSON.stringify({...wellFormed, findings: undefined})));
			assert.isNull(parseBaseline(JSON.stringify({...wellFormed, scanned: [1]})));
			assert.isNull(parseBaseline(JSON.stringify({...wellFormed, fenceCount: "1"})));
		});

		it("rejects a finding with no `cli` — a manifest predating the two-CLI split (#5679)", () => {
			const legacy = {...wellFormed, findings: [{file: "a.md", line: 2, text: "pipeline-cli x"}]};
			assert.isNull(parseBaseline(JSON.stringify(legacy)));
			const current = {
				...wellFormed,
				findings: [{file: "a.md", line: 2, text: "pipeline-cli x", cli: "pipeline-cli" as const}],
			};
			assert.deepStrictEqual(parseBaseline(JSON.stringify(current)), current);
		});
	});
});
