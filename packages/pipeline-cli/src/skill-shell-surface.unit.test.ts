import {assert, describe, it} from "@effect/vitest";
import {
	resolveSection,
	skillSurfaceFromText,
	sourcedScriptNames,
	ZERO_SCOPE,
} from "./skill-shell-surface.ts";

// Build a literal `${…}` shell expansion without writing it as a plain-string placeholder, so
// biome's noTemplateCurlyInString stays quiet — every fixture here IS shell (the `settings-env-guard`
// idiom, #2495).
const brace = (inner: string): string => `$\{${inner}}`;

const sliceStep = (text: string): string => {
	const start = text.search(/^## Step X — /m);
	if (start < 0) return "";
	const rest = text.slice(start);
	const end = rest.slice(1).search(/^## /m);
	return end < 0 ? rest : rest.slice(0, end + 1);
};

describe("sourcedScriptNames", () => {
	it("names every `$<SKILL>_SCRIPTS/<file>.sh` a stretch of text sources, deduplicated in order", () => {
		const text = [
			'. "$SHIPIT_SCRIPTS/step3-rollup-bindings.sh"',
			`. "${brace("WRITE_CODE_SCRIPTS")}/step5_5-reconcile.sh"`,
			'. "$SHIPIT_SCRIPTS/step3-rollup-bindings.sh"',
		].join("\n");
		assert.deepStrictEqual(sourcedScriptNames(text), [
			"step3-rollup-bindings.sh",
			"step5_5-reconcile.sh",
		]);
	});

	it("names every ADR-0232 literal-path `bash ./…/scripts/<file>.sh` invocation too", () => {
		// The whole point of matching this form: a converted section that resolved to the markdown
		// alone would read back with ZERO bindings, and every constant the parsers follow into the
		// script would look absent rather than unfollowed (#4572).
		const text = [
			"bash ./claude-plugins/kampus-pipeline/skills/ship-it/scripts/step3-rollup-bindings.sh $REPO $PR",
			'bash "./claude-plugins/kampus-pipeline/skills/ship-it/scripts/step5_5-reconcile.sh"',
			"bash ./claude-plugins/kampus-pipeline/skills/ship-it/scripts/step3-rollup-bindings.sh $REPO $PR",
		].join("\n");
		assert.deepStrictEqual(sourcedScriptNames(text), [
			"step3-rollup-bindings.sh",
			"step5_5-reconcile.sh",
		]);
	});

	it("names nothing for text that sources nothing — the un-extracted corpus", () => {
		assert.deepStrictEqual(sourcedScriptNames(`RECONCILE_TRIES=${brace("X:-16")}\n`), []);
	});

	// The falsification: drop the `/scripts` alternative from the matcher and this reds. Without it
	// the literal-path case above would return [] and the parsers would silently narrow.
	it("does not match a bare `.sh` mention that is not a scripts/ path", () => {
		assert.deepStrictEqual(sourcedScriptNames("see verify-chain-resolves.sh for the proof"), []);
	});
});

describe("resolveSection — a section's surface is its slice plus the scripts it sources", () => {
	it("appends each resolvable script and emits both files as the scanned scope", () => {
		const surface = skillSurfaceFromText(
			["## Step X — do it", '. "$SHIPIT_SCRIPTS/a.sh"', "## Step Y — next"].join("\n"),
			{"a.sh": "BUDGET=7"},
			"ship-it/SKILL.md",
		);
		const resolved = resolveSection(surface, sliceStep);
		assert.include(resolved.section, "BUDGET=7");
		assert.deepStrictEqual(resolved.scanned, ["ship-it/SKILL.md", "scripts/a.sh"]);
		assert.deepStrictEqual(resolved.unresolved, []);
	});

	it("computes the boundary on the PRISTINE markdown, so a script's `## ` line cannot truncate it", () => {
		// The extracted gate scripts emit markdown from heredocs. Inlining before the slice would let
		// such a line end the section and blind the rest of it.
		const surface = skillSurfaceFromText(
			[
				"## Step X — do it",
				'. "$SHIPIT_SCRIPTS/emits-markdown.sh"',
				"TAIL_OF_SECTION=1",
				"## Step Y — next",
				"NOT_IN_SECTION=1",
			].join("\n"),
			{"emits-markdown.sh": "cat <<EOF\n## Step Y — a heading in a heredoc\nEOF\nBUDGET=7"},
		);
		const resolved = resolveSection(surface, sliceStep);
		assert.include(resolved.section, "TAIL_OF_SECTION=1");
		assert.include(resolved.section, "BUDGET=7");
		assert.notInclude(resolved.section, "NOT_IN_SECTION=1");
	});

	it("reports an unreadable sourced script as UNRESOLVED — it never silently drops it", () => {
		const surface = skillSurfaceFromText(
			["## Step X — do it", '. "$SHIPIT_SCRIPTS/gone.sh"', "## Step Y — next"].join("\n"),
		);
		const resolved = resolveSection(surface, sliceStep);
		assert.deepStrictEqual(resolved.unresolved, ["gone.sh"]);
		assert.deepStrictEqual(resolved.scanned, ["SKILL.md"]);
	});

	it("treats an EMPTY script as unresolved, not as a script that legitimately says nothing", () => {
		const surface = skillSurfaceFromText(
			["## Step X — do it", '. "$SHIPIT_SCRIPTS/empty.sh"'].join("\n"),
			{"empty.sh": ""},
		);
		assert.deepStrictEqual(resolveSection(surface, sliceStep).unresolved, ["empty.sh"]);
	});

	it("an unmatched heading is ZERO SCOPE — scanned is empty, which a caller must fail closed on", () => {
		const surface = skillSurfaceFromText("## Step Z — a different step\nBUDGET=7");
		assert.deepStrictEqual(resolveSection(surface, sliceStep), ZERO_SCOPE);
		assert.deepStrictEqual(ZERO_SCOPE.scanned, []);
	});

	it("is a no-op on a section that sources nothing, so the un-extracted corpus still parses", () => {
		const surface = skillSurfaceFromText("## Step X — do it\nBUDGET=7\n## Step Y — next");
		const resolved = resolveSection(surface, sliceStep);
		assert.include(resolved.section, "BUDGET=7");
		assert.deepStrictEqual(resolved.scanned, ["SKILL.md"]);
	});
});
