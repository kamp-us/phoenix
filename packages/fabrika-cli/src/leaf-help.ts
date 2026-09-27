/**
 * The rule for a leaf verb's long `--help` description, and the ratchet that holds it while the
 * registered verbs migrate onto it.
 *
 * The rule is `claude-plugins/fabrika/docs/interface-convention.md`, "Leaf help size and shape";
 * this module is its mechanical half. Every check below is one the rule states in a form a string
 * test can settle. What it cannot settle — whether a flag's detail is repeated, whether a line is
 * derivation — stays with the reviewer.
 */

/**
 * The whole-description budget, taken from the rule: `formatHelpDocImpl` (`effect@4.0.0-rc.112`,
 * `src/unstable/cli/CliOutput.ts`) prints the block as `  ${description}`, so a line holds 98
 * characters at a 100-column terminal, and the total is one 98-character summary plus twelve lines
 * averaging 41 characters with their newlines — 590, rounded up to 600.
 */
export const LEAF_HELP_BUDGET = 600;

/** A line's text budget after its two-space indent, from the same 100-column renderer read. */
export const LEAF_HELP_LINE_BUDGET = 98;

const INDENT = "  ";
const EXIT_LINE = /^ {2}(\d+): \S/;

/**
 * Every way a leaf description fails the rule, named — an empty list is the pass.
 *
 * Reported as a list rather than a boolean so the test that reds tells the author which rule broke.
 */
export const leafHelpDefects = (text: string | undefined): ReadonlyArray<string> => {
	if (text === undefined || text.trim() === "")
		return ["absent — the verb declares no description"];
	const defects: Array<string> = [];
	if (text.length > LEAF_HELP_BUDGET) {
		defects.push(`${text.length} characters, over the ${LEAF_HELP_BUDGET}-character budget`);
	}
	const [summary = "", ...rest] = text.split("\n");
	if (summary.length > LEAF_HELP_LINE_BUDGET) {
		defects.push(
			`summary line is ${summary.length} characters, over the ${LEAF_HELP_LINE_BUDGET}-character line budget`,
		);
	}
	if (/[.!?]\s/.test(summary) || !summary.endsWith(".")) {
		defects.push("summary line is not one sentence ending in a full stop");
	}
	rest.forEach((line, index) => {
		const lineNumber = index + 2;
		if (!line.startsWith(INDENT) || line.startsWith(`${INDENT} `)) {
			defects.push(`line ${lineNumber} does not carry the two-space indent`);
		} else if (line.length - INDENT.length > LEAF_HELP_LINE_BUDGET) {
			defects.push(
				`line ${lineNumber} is ${line.length - INDENT.length} characters, over the ${LEAF_HELP_LINE_BUDGET}-character line budget`,
			);
		}
	});
	if (/example:/i.test(text)) {
		defects.push("carries Example: prose — examples go through Command.withExamples");
	}
	if (/\bexits?\s+\d/i.test(text)) {
		defects.push("names exit codes in prose — each exit gets its own `  <code>: <meaning>` line");
	}
	const codes = rest.flatMap((line) => {
		const match = EXIT_LINE.exec(line);
		return match === null ? [] : [Number(match[1])];
	});
	if (codes.some((code) => code === 0 || code === 1)) {
		defects.push("gives 0 or 1 an exit line — every verb shares those");
	}
	if (codes.some((code, index) => index > 0 && code <= (codes[index - 1] ?? code))) {
		defects.push("exit lines are not in ascending order");
	}
	return defects;
};

/**
 * The runtime shape of a registered `Command` this walk reads. It is structural on purpose: the
 * registry's `Command` type does not expose `description`, and widening to this interface is a
 * plain assignment, so a rename upstream reds at build time rather than reading `undefined`.
 */
export interface DescribedNode {
	readonly name: string;
	readonly description?: string | undefined;
	readonly subcommands: ReadonlyArray<{readonly commands: ReadonlyArray<DescribedNode>}>;
}

/** One leaf verb's description, keyed by its group and its path under that group. */
export interface LeafHelp {
	readonly group: string;
	/** The path below the group, space-joined — `claims stale` for `fabrika build claims stale`. */
	readonly verb: string;
	readonly description: string | undefined;
}

/** Every leaf verb under the given groups, in registration order. */
export const leafHelpWalk = (groups: ReadonlyArray<DescribedNode>): ReadonlyArray<LeafHelp> => {
	const below = (
		node: DescribedNode,
		path: ReadonlyArray<string>,
	): ReadonlyArray<DescribedNode[]> => {
		const children = node.subcommands.flatMap((set) => set.commands);
		if (children.length === 0) return [[node]];
		return children.flatMap((child) =>
			below(child, [...path, child.name]).map((chain) => [node, ...chain]),
		);
	};
	return groups.flatMap((group) =>
		below(group, []).map((chain) => ({
			group: group.name,
			verb: chain
				.slice(1)
				.map((node) => node.name)
				.join(" "),
			description: chain.at(-1)?.description,
		})),
	);
};

/**
 * One group's baseline: each verb that broke the rule when the ratchet landed, with the length its
 * description had then. It lives in that group's own directory, so its keys are group-relative.
 */
export type LeafHelpBaseline = Readonly<Record<string, number>>;

/** The file name a group's baseline carries inside `src/<group>/`. */
export const LEAF_HELP_BASELINE_FILE = "leaf-help-baseline.json";

/** Why the ratchet reds. Each kind names the one edit that clears it. */
export type RatchetFinding =
	| {readonly kind: "no-leaves"}
	| {
			readonly kind: "unbaselined";
			readonly group: string;
			readonly verb: string;
			readonly defects: ReadonlyArray<string>;
	  }
	| {
			readonly kind: "grew";
			readonly group: string;
			readonly verb: string;
			readonly length: number;
			readonly recorded: number;
	  }
	| {readonly kind: "stale"; readonly group: string; readonly verb: string}
	| {readonly kind: "unknown-verb"; readonly group: string; readonly verb: string};

/**
 * The ratchet over a walk: a verb breaking the rule must be in its group's baseline and no longer
 * than recorded, and a baseline row must name a registered verb that still breaks it. An empty
 * walk is a finding, never a pass.
 */
export const leafHelpRatchet = (
	walk: ReadonlyArray<LeafHelp>,
	baselines: ReadonlyMap<string, LeafHelpBaseline>,
): ReadonlyArray<RatchetFinding> => {
	if (walk.length === 0) return [{kind: "no-leaves"}];
	const findings: Array<RatchetFinding> = [];
	const seen = new Set<string>();
	for (const {group, verb, description} of walk) {
		seen.add(`${group}\u0000${verb}`);
		const defects = leafHelpDefects(description);
		const recorded = baselines.get(group)?.[verb];
		if (defects.length === 0) {
			if (recorded !== undefined) findings.push({kind: "stale", group, verb});
		} else if (recorded === undefined) {
			findings.push({kind: "unbaselined", group, verb, defects});
		} else {
			const length = description?.length ?? 0;
			if (length > recorded) findings.push({kind: "grew", group, verb, length, recorded});
		}
	}
	for (const [group, baseline] of baselines) {
		for (const verb of Object.keys(baseline)) {
			if (!seen.has(`${group}\u0000${verb}`)) findings.push({kind: "unknown-verb", group, verb});
		}
	}
	return findings;
};

/** A finding as the line a failing test prints, naming the edit that clears it. */
export const describeFinding = (finding: RatchetFinding): string => {
	switch (finding.kind) {
		case "no-leaves":
			return "the walk found zero registered leaf verbs — nothing was checked";
		case "unbaselined":
			return `fabrika ${finding.group} ${finding.verb}: breaks the leaf help rule (${finding.defects.join("; ")})`;
		case "grew":
			return `fabrika ${finding.group} ${finding.verb}: grew to ${finding.length} characters, past its baseline of ${finding.recorded}`;
		case "stale":
			return `fabrika ${finding.group} ${finding.verb}: now passes the rule — delete its row from src/${finding.group}/${LEAF_HELP_BASELINE_FILE}`;
		case "unknown-verb":
			return `fabrika ${finding.group} ${finding.verb}: no such registered verb — delete its row from src/${finding.group}/${LEAF_HELP_BASELINE_FILE}`;
	}
};
