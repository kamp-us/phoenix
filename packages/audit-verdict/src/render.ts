/**
 * Render a `Verdict` to its two archived forms — both diffable, neither an HTML UI:
 *   - JSON: the canonical machine form the run-over-run diff reads back.
 *   - Markdown: the human-readable form (overall + per-dimension table + failing-finding
 *     evidence) so a reader sees the verdict without parsing JSON.
 *
 * `buildVerdict` already orders `perDimension`/`findings` deterministically, so a fixed
 * verdict renders byte-stable — two dated runs diff mechanically at the text level too.
 */
import type {Verdict} from "./schema.ts";

/** Canonical JSON — the verdict is already field-ordered + sorted by `buildVerdict`. */
export const renderVerdictJson = (verdict: Verdict): string =>
	`${JSON.stringify(verdict, null, "\t")}\n`;

const STATUS_MARK: Record<string, string> = {PASS: "PASS", FAIL: "FAIL", BLOCKED: "BLOCKED"};

/**
 * The human-readable archive. Failing dimensions get their findings expanded with the
 * evidence the rubric recorded (screenshot ref / offending selector / leaking surface /
 * broken transition) so a regression is self-explanatory in the artifact itself.
 */
export const renderVerdictMarkdown = (verdict: Verdict): string => {
	const lines: string[] = [];
	lines.push(`# rite-audit verdict — ${verdict.overall}`);
	lines.push("");
	lines.push(`- **Date:** ${verdict.date}`);
	lines.push(`- **Stage:** ${verdict.target.stage}`);
	lines.push(`- **Base URL:** ${verdict.target.baseUrl}`);
	lines.push(`- **Overall:** ${STATUS_MARK[verdict.overall] ?? verdict.overall}`);
	lines.push("");
	lines.push("## Dimensions");
	lines.push("");
	lines.push("| Dimension | Status |");
	lines.push("| --- | --- |");
	for (const d of verdict.perDimension) {
		lines.push(`| \`${d.dimension}\` | ${STATUS_MARK[d.status] ?? d.status} |`);
	}
	lines.push("");

	const failing = verdict.findings.filter((f) => f.status !== "PASS");
	lines.push("## Evidence");
	lines.push("");
	if (failing.length === 0) {
		lines.push("No failing findings.");
	} else {
		for (const f of failing) {
			lines.push(`### \`${f.dimension}\` · ${f.check} · \`${f.surface}\` — ${f.status}`);
			lines.push("");
			lines.push(`- **Expected:** ${f.expected}`);
			lines.push(`- **Observed:** ${f.observed}`);
			lines.push(`- **Evidence:** ${f.evidence}`);
			lines.push("");
		}
	}
	return `${lines.join("\n").trimEnd()}\n`;
};
