import {assert, describe, it} from "@effect/vitest";
import {
	enablesErrexit,
	installsExitTrap,
	isZeroScope,
	scanCorpus,
	scanFile,
} from "./trap-status-guard.ts";

const TICKS = "```";
const fence = (lang: string, ...lines: ReadonlyArray<string>): string =>
	[`${TICKS}${lang}`, ...lines, TICKS].join("\n");

const sh = (...lines: ReadonlyArray<string>): string =>
	["#!/usr/bin/env bash", ...lines].join("\n");

describe("enablesErrexit", () => {
	it("reads errexit off every form that turns it on", () => {
		for (const line of [
			"set -e",
			"set -eu",
			"set -euo pipefail",
			"set -o errexit",
			"set -ueo pipefail",
		]) {
			assert.isTrue(enablesErrexit(line), line);
		}
	});

	it("does not read errexit into the house shape or into an unrelated option", () => {
		for (const line of [
			"set -uo pipefail",
			"set -u",
			"set -o pipefail",
			"set -x",
			"set -o nounset",
		]) {
			assert.isFalse(enablesErrexit(line), line);
		}
	});

	it("honours a later disable — `+e` and `+o errexit` turn it back off", () => {
		assert.isFalse(enablesErrexit("set +e"));
		assert.isFalse(enablesErrexit("set +o errexit"));
	});
});

describe("installsExitTrap", () => {
	it("recognises a cleanup trap install", () => {
		assert.isTrue(installsExitTrap(`trap 'rm -rf "$tmp_root"' EXIT`));
		assert.isTrue(installsExitTrap(`trap cleanup exit`));
		assert.isTrue(installsExitTrap(`trap 'rc=$?; rm -rf "$t"; exit $rc' EXIT`));
	});

	it("does not treat a trap RESET as an install", () => {
		assert.isFalse(installsExitTrap("trap - EXIT"));
		assert.isFalse(installsExitTrap("trap -- - EXIT"));
	});

	it("ignores a trap on another signal and a line that merely mentions exit", () => {
		assert.isFalse(installsExitTrap("trap 'echo interrupted' INT TERM"));
		assert.isFalse(installsExitTrap('echo "the trap must not swallow the status"'));
	});
});

describe("trap-status-guard core — the banned co-occurrence", () => {
	it("flags a shell file that pairs errexit with a cleanup EXIT trap, locating both halves", () => {
		const {findings} = scanFile(
			"guard.sh",
			sh("set -euo pipefail", 'tmp_root="$(mktemp -d)"', `trap 'rm -rf "$tmp_root"' EXIT`),
		);
		assert.strictEqual(findings.length, 1);
		assert.strictEqual(findings[0]?.errexitLine, 2);
		assert.strictEqual(findings[0]?.trapLine, 4);
		assert.include(findings[0]?.trapText ?? "", "rm -rf");
	});

	it("still flags the status-preserving trap — under -e `$?` is already 0 when it runs", () => {
		const {findings} = scanFile(
			"guard.sh",
			sh("set -euo pipefail", 'tmp="$(mktemp -d)"', `trap 'rc=$?; rm -rf "$tmp"; exit $rc' EXIT`),
		);
		assert.strictEqual(findings.length, 1);
	});

	it("accepts the house shape — the same cleanup trap without errexit", () => {
		const {findings} = scanFile(
			"guard.sh",
			sh("set -uo pipefail", 'tmp_root="$(mktemp -d)"', `trap 'rm -rf "$tmp_root"' EXIT`),
		);
		assert.deepStrictEqual(findings, []);
	});

	it("accepts errexit with no EXIT trap, and an EXIT trap with no errexit", () => {
		assert.deepStrictEqual(scanFile("a.sh", sh("set -euo pipefail", "echo hi")).findings, []);
		assert.deepStrictEqual(
			scanFile("b.sh", sh("set -uo pipefail", "trap 'rm -rf \"$t\"' EXIT")).findings,
			[],
		);
	});

	it("ignores a commented-out option and a commented-out trap", () => {
		const {findings} = scanFile(
			"guard.sh",
			sh("# set -euo pipefail", "set -uo pipefail", `# trap 'rm -rf "$t"' EXIT`),
		);
		assert.deepStrictEqual(findings, []);
	});

	it("still fires when errexit is disabled LATER — the region between is the defect", () => {
		// Fail-closed direction: the swallow needs errexit on at the moment of the abort, which can
		// be anywhere. A `set +e` further down narrows the window, it does not close it — so an
		// enable anywhere in the unit is a finding, and only the whole-unit shape clears it.
		const {findings} = scanFile(
			"guard.sh",
			sh("set -euo pipefail", "set +e", `trap 'rm -rf "$t"' EXIT`),
		);
		assert.strictEqual(findings.length, 1);
		assert.strictEqual(findings[0]?.errexitLine, 2);
	});
});

describe("trap-status-guard core — the unit of scan", () => {
	it("judges a markdown fence as one unit: the pairing inside one fence is a finding", () => {
		const {findings, fences} = scanFile(
			"SKILL.md",
			fence("bash", "set -euo pipefail", `trap 'rm -rf "$t"' EXIT`),
		);
		assert.strictEqual(fences, 1);
		assert.strictEqual(findings.length, 1);
	});

	it("does not join halves that live in two different fences", () => {
		const {findings, fences} = scanFile(
			"SKILL.md",
			[
				fence("bash", "set -euo pipefail", "echo one"),
				fence("bash", `trap 'rm -rf "$t"' EXIT`),
			].join("\n"),
		);
		assert.strictEqual(fences, 2);
		assert.deepStrictEqual(findings, []);
	});

	it("skips a non-runnable fence, so a doc may show the banned shape as an example", () => {
		const {findings, fences} = scanFile(
			"pattern.md",
			fence("text", "set -euo pipefail", `trap 'rm -rf "$t"' EXIT`),
		);
		assert.strictEqual(fences, 0);
		assert.deepStrictEqual(findings, []);
	});

	it("reads a blockquoted fence — an agent copies a `> `-prefixed snippet the same way", () => {
		const quoted = fence("bash", "set -euo pipefail", `trap 'rm -rf "$t"' EXIT`)
			.split("\n")
			.map((l) => `> ${l}`)
			.join("\n");
		assert.strictEqual(scanFile("SKILL.md", quoted).findings.length, 1);
	});

	it("does not interpret fence delimiters inside a .sh — a heredoc's ``` must not blind the rest", () => {
		const {findings} = scanFile(
			"guard.sh",
			sh(
				"set -euo pipefail",
				"cat <<EOF > body.md",
				TICKS,
				"some fenced markdown in a PR body",
				TICKS,
				"EOF",
				`trap 'rm -rf "$t"' EXIT`,
			),
		);
		assert.strictEqual(findings.length, 1);
	});
});

describe("trap-status-guard core — scope (ADR 0092)", () => {
	it("reports both scope axes across a mixed corpus", () => {
		const result = scanCorpus([
			{file: "a.sh", content: sh("set -uo pipefail")},
			{file: "b.md", content: fence("bash", "echo hi")},
		]);
		assert.deepStrictEqual(result.scanned, ["a.sh", "b.md"]);
		assert.strictEqual(result.shellFileCount, 1);
		assert.strictEqual(result.fenceCount, 1);
		assert.isFalse(isZeroScope(result));
	});

	it("is zero scope when any single axis collapses, not only when all do", () => {
		assert.isTrue(isZeroScope(scanCorpus([])));
		assert.isTrue(isZeroScope(scanCorpus([{file: "a.sh", content: sh("set -uo pipefail")}])));
		assert.isTrue(isZeroScope(scanCorpus([{file: "b.md", content: fence("bash", "echo hi")}])));
	});
});
