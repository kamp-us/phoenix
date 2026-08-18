import {assert, describe, it} from "@effect/vitest";
import {
	checkFrontmatter,
	isFrontmatterScoped,
	isSelfExempt,
	isZeroScope,
	lintCorpus,
	type ScanFile,
	scanBarePush,
	scanFencePortability,
	scanFile,
} from "./skill-lint.ts";

// The #1766 trigger, verbatim shape: an unquoted `description:` whose prose carries a
// mid-sentence colon-space (`ritual: pre-flight`) — strict YAML reparses it as a nested
// mapping (the same break GitHub's renderer surfaces on release/SKILL.md, shipper.md).
const BROKEN_FRONTMATTER = [
	"---",
	"name: release",
	"description: run the five-step ritual: pre-flight the flag and flip it live",
	"---",
	"",
	"# release",
].join("\n");

// The durable fix: a quoted scalar. The mid-sentence colon-space can no longer be reparsed.
const QUOTED_FRONTMATTER = [
	"---",
	"name: release",
	'description: "run the five-step ritual: pre-flight the flag and flip it live"',
	"---",
	"",
	"# release",
].join("\n");

// The `>-` folded block scalar form (the release/SKILL.md #1769 fix shape) — also valid.
const FOLDED_FRONTMATTER = [
	"---",
	"name: release",
	"description: >-",
	"  run the five-step ritual: pre-flight the flag and flip it live",
	"---",
	"",
	"# release",
].join("\n");

describe("scanFile — flags GraphQL-path gh calls", () => {
	it("flags `gh project` in a skill body", () => {
		const findings = scanFile(".claude/skills/foo/SKILL.md", "run `gh project list --owner x`");
		assert.isAbove(findings.length, 0);
		assert.include(findings[0]?.matched ?? "", "gh project");
		assert.strictEqual(findings[0]?.line, 1);
	});

	it("flags `gh pr edit`", () => {
		const findings = scanFile("skills/bar/SKILL.md", "first\nuse gh pr edit 5 --body x\n");
		assert.strictEqual(findings.length, 1);
		assert.strictEqual(findings[0]?.line, 2);
	});

	it("flags `gh issue edit`", () => {
		assert.isAbove(scanFile("s/SKILL.md", "gh issue edit 7 --add-project P").length, 0);
	});

	it("flags `gh api graphql`", () => {
		assert.isAbove(scanFile("s/SKILL.md", "gh api graphql -f query='{...}'").length, 0);
	});

	it("does NOT flag a safe `gh api repos/...` REST call", () => {
		assert.strictEqual(scanFile("s/SKILL.md", "gh api repos/o/r/issues/1").length, 0);
	});

	it("does NOT flag prose that mentions projects without the gh verb", () => {
		assert.strictEqual(scanFile("s/SKILL.md", "the project board is classic").length, 0);
	});

	it("self-exempts the ADR-0158 sanctioned read PER SCRIPT, not the scripts/ directory", () => {
		assert.isTrue(isSelfExempt("skills/review-code/scripts/unresolved-threads-read.sh"));
		assert.isFalse(isSelfExempt("skills/review-code/scripts/pr-diff.sh"));
		assert.isAbove(
			scanFile("skills/review-code/scripts/pr-diff.sh", "gh api graphql -f query='{...}'").length,
			0,
		);
	});

	it("self-exempts the write-code skill (it documents the REST-only rule)", () => {
		assert.isTrue(isSelfExempt(".claude/skills/write-code/SKILL.md"));
		assert.strictEqual(
			scanFile("skills/write-code/SKILL.md", "gh pr edit is unreliable").length,
			0,
		);
	});

	it("self-exempts write-code/repair.md per FILE, leaving its siblings live", () => {
		assert.isTrue(isSelfExempt(".claude/skills/write-code/repair.md"));
		assert.strictEqual(
			scanFile("skills/write-code/repair.md", "gh pr edit is unreliable").length,
			0,
		);
		// The granularity assertion: a sibling under the same directory is NOT exempt, so the
		// exemption can never widen into a `write-code/`-wide hole.
		assert.isFalse(isSelfExempt("skills/write-code/type-routing.md"));
		assert.strictEqual(
			scanFile("skills/write-code/type-routing.md", "gh pr edit is unreliable").length,
			1,
		);
	});

	it("self-exempts fabrika's triage contract per FILE, leaving the rest of fabrika live", () => {
		assert.isTrue(isSelfExempt("claude-plugins/fabrika/skills/triage/contract.md"));
		assert.strictEqual(
			scanFile(
				"claude-plugins/fabrika/skills/triage/contract.md",
				"`gh issue edit --add-label` rejects an unknown label client-side",
			).length,
			0,
		);
		// The exemption is plugin-qualified, so kampus-pipeline's own triage skill stays live.
		assert.isFalse(isSelfExempt("claude-plugins/kampus-pipeline/skills/triage/contract.md"));
		assert.isFalse(isSelfExempt("claude-plugins/fabrika/skills/triage/SKILL.md"));
		assert.strictEqual(
			scanFile("claude-plugins/fabrika/skills/triage/SKILL.md", "gh issue edit --add-label").length,
			1,
		);
	});
});

describe("lintCorpus — scope + findings", () => {
	const corpus: ReadonlyArray<ScanFile> = [
		{file: "skills/a/SKILL.md", content: "gh project view"},
		{file: "skills/b/SKILL.md", content: "gh api repos/o/r/issues/1"},
		{file: "skills/write-code/SKILL.md", content: "gh pr edit (documented)"},
	];

	it("scans only the non-exempt files and reports them as scope", () => {
		const result = lintCorpus(corpus);
		assert.deepStrictEqual([...result.scanned], ["skills/a/SKILL.md", "skills/b/SKILL.md"]);
	});

	it("returns the finding from the offending file", () => {
		const result = lintCorpus(corpus);
		assert.strictEqual(result.findings.length, 1);
		assert.strictEqual(result.findings[0]?.file, "skills/a/SKILL.md");
	});
});

describe("isZeroScope — fail-closed on zero scope (ADR 0092)", () => {
	it("reports zero scope when nothing was scanned (empty corpus)", () => {
		assert.isTrue(isZeroScope(lintCorpus([])));
	});

	it("reports zero scope when every handed file was self-exempt", () => {
		const result = lintCorpus([{file: "skills/write-code/SKILL.md", content: "gh pr edit"}]);
		assert.strictEqual(result.scanned.length, 0);
		assert.isTrue(isZeroScope(result));
	});

	it("is NOT zero scope when at least one non-exempt file was scanned", () => {
		const result = lintCorpus([{file: "skills/a/SKILL.md", content: FOLDED_FRONTMATTER}]);
		assert.isFalse(isZeroScope(result));
	});
});

describe("isFrontmatterScoped — SKILL.md and agents/*.md carry frontmatter", () => {
	it("scopes a SKILL.md", () => {
		assert.isTrue(isFrontmatterScoped("claude-plugins/kampus-pipeline/skills/release/SKILL.md"));
	});

	it("scopes an agents/<name>.md", () => {
		assert.isTrue(isFrontmatterScoped("claude-plugins/kampus-pipeline/agents/coder.md"));
	});

	it("does NOT scope a non-frontmatter corpus file (a plain doc or script)", () => {
		assert.isFalse(isFrontmatterScoped("skills/foo/notes.md"));
		assert.isFalse(isFrontmatterScoped("skills/foo/helper.sh"));
	});
});

describe("checkFrontmatter — the #1766 gate (red-then-green)", () => {
	// RED: the exact recurring defect — an unquoted description with a mid-sentence
	// colon-space fails the strict-YAML parse (#1281 shipper.md, #1769 release/SKILL.md).
	it("FAILS an unquoted `description:` with a mid-sentence colon-space", () => {
		const finding = checkFrontmatter("skills/release/SKILL.md", BROKEN_FRONTMATTER);
		assert.isNotNull(finding);
		assert.strictEqual(finding?.file, "skills/release/SKILL.md");
		assert.isAbove((finding?.reason ?? "").length, 0);
	});

	// GREEN: the durable per-file fix — a quoted scalar parses clean.
	it("PASSES a quoted `description:` scalar", () => {
		assert.isNull(checkFrontmatter("skills/release/SKILL.md", QUOTED_FRONTMATTER));
	});

	// GREEN: the `>-` folded block scalar (the release/SKILL.md #1769 fix shape) parses clean.
	it("PASSES a `>-` folded block-scalar `description:`", () => {
		assert.isNull(checkFrontmatter("skills/release/SKILL.md", FOLDED_FRONTMATTER));
	});

	it("PASSES an agents/<name>.md with valid frontmatter", () => {
		assert.isNull(checkFrontmatter("agents/coder.md", QUOTED_FRONTMATTER));
	});

	it("does NOT run on a non-frontmatter-scoped file even if its body looks broken", () => {
		assert.isNull(checkFrontmatter("skills/foo/notes.md", BROKEN_FRONTMATTER));
	});

	it("does NOT flag a scoped file with no frontmatter fence (missing ≠ invalid)", () => {
		assert.isNull(checkFrontmatter("skills/foo/SKILL.md", "# just a heading, no fence"));
	});
});

describe("lintCorpus — frontmatter findings + scope (ADR 0092)", () => {
	it("reports a broken-frontmatter file as a frontmatterFinding", () => {
		const result = lintCorpus([{file: "skills/release/SKILL.md", content: BROKEN_FRONTMATTER}]);
		assert.strictEqual(result.frontmatterFindings.length, 1);
		assert.strictEqual(result.frontmatterFindings[0]?.file, "skills/release/SKILL.md");
	});

	it("reports no frontmatterFinding for a corpus whose frontmatter all parses", () => {
		const result = lintCorpus([{file: "skills/release/SKILL.md", content: QUOTED_FRONTMATTER}]);
		assert.strictEqual(result.frontmatterFindings.length, 0);
	});

	it("still frontmatter-checks a gh-call self-exempt skill (exempt from grep ≠ exempt from YAML)", () => {
		// write-code/SKILL.md is self-exempt from the gh-grep, but its frontmatter must still parse.
		const result = lintCorpus([{file: "skills/write-code/SKILL.md", content: BROKEN_FRONTMATTER}]);
		assert.strictEqual(result.findings.length, 0); // grep exempt
		assert.strictEqual(result.frontmatterFindings.length, 1); // frontmatter NOT exempt
		assert.deepStrictEqual([...result.frontmatterScanned], ["skills/write-code/SKILL.md"]);
	});

	it("is zero scope when NO frontmatter-bearing file was handed (frontmatter scope empty)", () => {
		// A corpus of only non-frontmatter files: gh-scan has scope, frontmatter check has none.
		const result = lintCorpus([{file: "skills/foo/helper.sh", content: "echo hi"}]);
		assert.strictEqual(result.frontmatterScanned.length, 0);
		assert.isTrue(isZeroScope(result));
	});
});

// #4213 — the bare-`git push` check. The corpus must be able to *talk about* a bare push
// (it has to, to explain why it is forbidden) while the runnable form is impossible to ship.
const fenced = (...body: ReadonlyArray<string>) => ["```bash", ...body, "```"].join("\n");

describe("scanBarePush — executable `git push` only (#4213)", () => {
	it("flags a bare `git push` inside a fenced shell block", () => {
		const f = scanBarePush("skills/x/SKILL.md", fenced('git push -u origin "$BRANCH"'));
		assert.strictEqual(f.length, 1);
		assert.strictEqual(f[0]?.line, 2);
		assert.include(f[0]?.reason ?? "", "fabrika build push");
	});

	it('flags the `git -C "$WT" push` form (the write-code Step-5 shape)', () => {
		const f = scanBarePush("skills/x/SKILL.md", fenced('git -C "$WT" push -u origin "$BRANCH"'));
		assert.strictEqual(f.length, 1);
	});

	it("flags a force-push (the write-code Step-R3 shape)", () => {
		const f = scanBarePush(
			"skills/x/SKILL.md",
			fenced("wt_preflight && git push --force-with-lease origin HEAD"),
		);
		assert.strictEqual(f.length, 1);
	});

	it("flags a push inside a BLOCKQUOTED fence — the corpus nests its most critical blocks that way", () => {
		const content = ["> ```bash", "> git push origin HEAD", "> ```"].join("\n");
		assert.strictEqual(scanBarePush("skills/x/SKILL.md", content).length, 1);
	});

	it("does NOT flag prose mentioning `git push` outside any fence", () => {
		const content = "A `git push`/`git commit` op after a cwd reset runs in the primary tree.";
		assert.strictEqual(scanBarePush("skills/x/SKILL.md", content).length, 0);
	});

	it("does NOT flag the sanctioned verb, which contains no `git push` at all", () => {
		const f = scanBarePush(
			"skills/x/SKILL.md",
			fenced('fabrika build push --cwd "$WT" --branch "$BRANCH"'),
		);
		assert.strictEqual(f.length, 0);
	});

	it("does NOT flag a placeholder like `git <commit|push|switch …>`", () => {
		assert.strictEqual(
			scanBarePush("skills/x/SKILL.md", fenced("git <commit|push|switch …>")).length,
			0,
		);
	});

	it("treats a .sh file as executable throughout (no fence needed)", () => {
		assert.strictEqual(scanBarePush("hooks/deploy.sh", "git push origin main\n").length, 1);
	});

	it("is out of scope for a non-.md/.sh file", () => {
		assert.strictEqual(scanBarePush("src/thing.ts", "git push origin main").length, 0);
	});

	// #4217 — the pattern itself must not be wedgeable. This gate runs on every
	// `pull_request` over a corpus anyone can add a line to, and a hung job presents as
	// *running*, not failed, so a crafted line that never reaches `push` must still return.
	// Both shapes below hung for 60+ SECONDS on real, shipped-at-the-time patterns; the 1 s
	// bound is a ~60x margin over the fixed pattern's sub-millisecond time, so it pins the
	// linearity without flaking on a loaded CI box. Deleting these is how the ambiguity
	// silently comes back.
	describe("is not exponentially backtrackable (#4217)", () => {
		const boundedScan = (line: string) => {
			const t0 = performance.now();
			const findings = scanBarePush("skills/x/SKILL.md", fenced(line));
			return {ms: performance.now() - t0, findings};
		};

		it("returns fast on a long `--a=b=c` run that never reaches `push`", () => {
			// `--\S+=\S+\s+` overlapping `-\S+\s+`, re-split at every `=`: 165 chars → 74.8 s.
			const {ms, findings} = boundedScan(`git ${"--a=b=c ".repeat(400)}x`);
			assert.strictEqual(findings.length, 0);
			assert.isBelow(ms, 1000);
		});

		it("returns fast on a long `-c` run that never reaches `push`", () => {
			// `-[cC]\s+\S+\s+` overlapping `-\S+\s+` on a bare `-c` token: 140 chars → 64.0 s.
			const {ms, findings} = boundedScan(`git ${"-c ".repeat(400)}x`);
			assert.strictEqual(findings.length, 0);
			assert.isBelow(ms, 1000);
		});

		it("returns fast on a mixed option flood that never reaches `push`", () => {
			const {ms, findings} = boundedScan(`git ${"-c a=b --x=y -C /d ".repeat(200)}x`);
			assert.strictEqual(findings.length, 0);
			assert.isBelow(ms, 1000);
		});

		// The disambiguator (`[^-\s]` on the `-c` VALUE) must not have narrowed what matches.
		it("still flags every real option form the push sites use", () => {
			for (const line of [
				"git -c a=b push",
				"git -c user.name=x -C /d push origin main",
				"git --git-dir=/x/.git push",
				"git --no-pager push",
				"git -c core.hooksPath=/dev/null push --force-with-lease origin HEAD",
				"git -C /d -c a=b --git-dir=/x/.git push",
			]) {
				assert.strictEqual(
					scanBarePush("skills/x/SKILL.md", fenced(line)).length,
					1,
					`expected a finding for: ${line}`,
				);
			}
		});
	});
});

describe("lintCorpus — bare-push findings + scope (ADR 0092)", () => {
	it("does NOT exempt write-code, the very file that owns both push sites", () => {
		const result = lintCorpus([
			{file: "skills/write-code/SKILL.md", content: fenced('git push -u origin "$BRANCH"')},
		]);
		assert.strictEqual(result.findings.length, 0); // gh-grep self-exempt
		assert.strictEqual(result.barePushFindings.length, 1); // push check is NOT
		assert.deepStrictEqual([...result.barePushScanned], ["skills/write-code/SKILL.md"]);
	});

	it("is zero scope — a FAIL — when the push check was handed nothing to scan", () => {
		const result = lintCorpus([{file: "agents/coder.txt", content: "git push origin main"}]);
		assert.strictEqual(result.barePushScanned.length, 0);
		assert.isTrue(isZeroScope(result));
	});
});

describe("scanFencePortability — the #4605 consumer-break gate", () => {
	it("reds on a repo-relative ./claude-plugins/ script path in a fence", () => {
		const f = scanFencePortability(
			"skills/write-code/SKILL.md",
			fenced("bash ./claude-plugins/kampus-pipeline/skills/write-code/scripts/step4-branch.sh x"),
		);
		assert.strictEqual(f.length, 1);
		assert.strictEqual(f[0]?.matched, "./claude-plugins/kampus-pipeline/skills/");
	});

	it("reds on a repo-relative shim assignment too — bin/, not only skills/", () => {
		const f = scanFencePortability(
			"agents/reviewer.md",
			fenced('PCLI="./claude-plugins/kampus-pipeline/bin/pipeline-cli"'),
		);
		assert.strictEqual(f.length, 1);
	});

	it("greens on the portable planted-link form", () => {
		const f = scanFencePortability(
			"skills/write-code/SKILL.md",
			fenced("bash ./.claude/.pipeline/skills/write-code/scripts/step4-branch.sh x"),
		);
		assert.strictEqual(f.length, 0);
	});

	it("leaves PROSE about the old form alone — the docs must be able to explain it", () => {
		const content = [
			"The old form was `bash ./claude-plugins/kampus-pipeline/skills/x/scripts/y.sh`.",
			fenced("bash ./.claude/.pipeline/skills/x/scripts/y.sh"),
		].join("\n");
		assert.strictEqual(scanFencePortability("skills/x/SKILL.md", content).length, 0);
	});

	it("leaves the marketplace manifest's `source:` value alone — no runnable-surface segment", () => {
		const f = scanFencePortability(
			"README.md",
			fenced('"source": "./claude-plugins/kampus-pipeline"'),
		);
		assert.strictEqual(f.length, 0);
	});

	it("leaves a `../claude-plugins/…` symlink target alone — the `.` is preceded by a `.`", () => {
		const f = scanFencePortability(
			"README.md",
			fenced("skills -> ../claude-plugins/kampus-pipeline/skills"),
		);
		assert.strictEqual(f.length, 0);
	});

	it("sees a fence nested in a blockquote — write-code's most safety-critical blocks are there", () => {
		const content = [
			"> ```bash",
			"> bash ./claude-plugins/kampus-pipeline/skills/write-code/scripts/step4-wt-preflight.sh",
			"> ```",
		].join("\n");
		assert.strictEqual(scanFencePortability("skills/write-code/SKILL.md", content).length, 1);
	});

	it("is markdown-only — a .sh is never pasted by an agent", () => {
		assert.strictEqual(
			scanFencePortability("hooks/x.sh", "bash ./claude-plugins/kampus-pipeline/skills/a/b.sh")
				.length,
			0,
		);
	});
});

describe("lintCorpus — portability findings + scope (ADR 0092)", () => {
	it("does NOT exempt write-code, the file that owns the most fences", () => {
		const result = lintCorpus([
			{
				file: "skills/write-code/SKILL.md",
				content: fenced("bash ./claude-plugins/kampus-pipeline/skills/write-code/scripts/a.sh"),
			},
		]);
		assert.strictEqual(result.findings.length, 0); // gh-grep self-exempt
		assert.strictEqual(result.portabilityFindings.length, 1); // portability check is NOT
		assert.deepStrictEqual([...result.portabilityScanned], ["skills/write-code/SKILL.md"]);
	});

	it("is zero scope — a FAIL — when the portability check was handed no markdown", () => {
		const result = lintCorpus([{file: "hooks/install.sh", content: "git push origin main"}]);
		assert.strictEqual(result.portabilityScanned.length, 0);
		assert.isTrue(isZeroScope(result));
	});
});
