/**
 * Parse ship-it Step 3's **branch-2 entry test** out of `ship-it/SKILL.md`, so the executable
 * branch mirror in `checks.unit.test.ts` derives its pending predicate from the shell it mirrors
 * instead of hand-copying it (#4054). Same drift-proof idiom as `class-probe`'s `HAS_*_RE` parse:
 * the skill's fenced block stays the single source, this reads it, no second copy exists to rot.
 *
 * Fail-closed in one direction only: a renamed Step 3, a missing entry condition, or a shell
 * variable the fenced block never binds to a rollup field all resolve to NO fields — which makes
 * the consuming guard red (nothing is ever pending ⇒ the #3999 regression cases stop settle-polling),
 * never quietly green.
 */

export interface Step3EntryTest {
	/** The literal shell condition, e.g. `[ -n "$RUNNING$WEDGED" ]`. Empty when unresolvable. */
	readonly condition: string;
	/** The `checks read` rollup fields that condition reads, resolved through the jq bindings. */
	readonly fields: ReadonlyArray<string>;
}

export const FAILCLOSED_STEP3_ENTRY_TEST: Step3EntryTest = {condition: "", fields: []};

/** The Step 3 section: its `## Step 3 — …` heading up to the next `## ` heading. */
export const extractStep3Section = (shipItText: string): string => {
	const start = shipItText.search(/^## Step 3 — /m);
	if (start < 0) return "";
	const section = shipItText.slice(start);
	const end = section.slice(1).search(/^## /m);
	return end < 0 ? section : section.slice(0, end + 1);
};

/**
 * The fenced block's `VAR=$(jq -r '.field …' <<<"$CI_JSON")` lines, as var → rollup field. The
 * leading `[` is optional because `GATING_RED` opens with a jq array comprehension (`'[.failing[]`).
 */
export const parseRollupBindings = (section: string): ReadonlyMap<string, string> => {
	const bindings = new Map<string, string>();
	for (const m of section.matchAll(
		/^([A-Z][A-Z0-9_]*)=\$\(jq\s+-r\s+'\s*\[?\s*\.([A-Za-z]\w*)/gm,
	)) {
		const [, name, field] = m;
		if (name !== undefined && field !== undefined && !bindings.has(name)) bindings.set(name, field);
	}
	return bindings;
};

/** One item of Step 3's numbered classification list, including its indented continuation lines. */
const numberedItem = (section: string, label: string): string => {
	const lines = section.split("\n");
	const start = lines.findIndex((l) => l.startsWith(`${label}. `));
	if (start < 0) return "";
	const item: string[] = [];
	for (const line of lines.slice(start)) {
		if (item.length > 0 && (/^\d+[a-z]?\.\s/.test(line) || (line !== "" && !/^\s/.test(line))))
			break;
		item.push(line);
	}
	return item.join("\n");
};

/**
 * The branch-2 entry test as the skill states it: its shell condition, and the rollup fields that
 * condition actually reads. `{[ -n "$RUNNING$WEDGED" ]} → ["running", "wedged"]` — the pending
 * sets. A rewrite to the rollup colour resolves elsewhere (or nowhere), which is the whole point.
 */
export const parseStep3EntryTest = (shipItText: string): Step3EntryTest => {
	const section = extractStep3Section(shipItText);
	const condition = numberedItem(section, "2").match(/`(\[[^`]*\])`/)?.[1] ?? "";
	if (condition === "") return FAILCLOSED_STEP3_ENTRY_TEST;
	const bindings = parseRollupBindings(section);
	const fields = [...condition.matchAll(/\$\{?([A-Z][A-Z0-9_]*)\}?/g)].flatMap((m) => {
		const bound = m[1] === undefined ? undefined : bindings.get(m[1]);
		return bound === undefined ? [] : [bound];
	});
	return {condition, fields: [...new Set(fields)].sort()};
};
