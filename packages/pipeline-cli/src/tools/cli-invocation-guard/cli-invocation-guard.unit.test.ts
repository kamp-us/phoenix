import {assert, describe, it} from "@effect/vitest";
import {isZeroScope, scanCorpus, scanFile} from "./cli-invocation-guard.ts";

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
