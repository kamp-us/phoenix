/**
 * The rule for a leaf verb's short list-row description — one string, mechanically checkable.
 *
 * Effect's help renderer reads one description for two audiences: the parent group's `SUBCOMMANDS`
 * row and the verb's own `DESCRIPTION` block. The convention
 * (`claude-plugins/fabrika/docs/cli-interface-convention.md` §1) makes the block the full contract —
 * shape, exit codes, an example — so reusing it as the list row emitted rows over a thousand
 * characters, unwrapped and untruncated (#5208). `Command.withShortDescription` adds the row's own
 * string without touching the contract, and this module is what keeps it a row.
 *
 * The budget is derived from the renderer, not chosen: `renderTable` (`effect@4.0.0-beta.92`,
 * `src/unstable/cli/CliOutput.ts`) prefixes two spaces and pads the name column to
 * `min(longestName + 4, 20)`, so the right column starts at column 22 and 78 columns are left at a
 * 100-column terminal. 72 keeps a margin for a longer verb name landing later.
 */
export const SHORT_DESCRIPTION_BUDGET = 72;

/**
 * Every way a short description fails the rule, named — an empty list is the pass.
 *
 * Reported as a list rather than a boolean so the test that reds tells the author which rule broke.
 */
export const shortDescriptionDefects = (text: string | undefined): ReadonlyArray<string> => {
	if (text === undefined || text.trim() === "")
		return ["absent — the verb declares no short description"];
	const defects: Array<string> = [];
	if (text.length > SHORT_DESCRIPTION_BUDGET) {
		defects.push(
			`${text.length} characters, over the ${SHORT_DESCRIPTION_BUDGET}-character budget`,
		);
	}
	if (/\bexits?\s+\d/i.test(text) || /\bexit code/i.test(text)) {
		defects.push("names an exit code — those belong in the verb's own --help");
	}
	if (/stdout/i.test(text) || text.includes("\t") || text.includes("\\t")) {
		defects.push("states the stdout grammar — that belongs in the verb's own --help");
	}
	if (/example:/i.test(text)) {
		defects.push("carries an example — that belongs in the verb's own --help");
	}
	if (/[.!?]\s/.test(text)) defects.push("is more than one sentence");
	if (!text.endsWith(".")) defects.push("does not end in a full stop");
	if (text.includes("\n")) defects.push("spans more than one line");
	return defects;
};
