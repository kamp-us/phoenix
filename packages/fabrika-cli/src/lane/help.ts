/**
 * The `lane` group's leaf help, composed in the shape `claude-plugins/fabrika/docs/interface-convention.md`
 * ("Leaf help size and shape") sets: a one-line summary, one `  <code>: <meaning>` line per exit in
 * ascending order, and a pointer to the verb's section of the operate skill's contract, where the
 * derivation lives.
 */

/** Exit code to its few-word meaning. Integer keys iterate ascending, which is the order the rule wants. */
export type ExitLines = Readonly<Record<number, string>>;

/** The two lanes-root refusals every repository-rooted verb shares, derived in `ground.ts`. */
export const ROOT_EXITS = {
	39: "no owning repository",
	65: "root in a linked worktree",
} as const satisfies ExitLines;

/** The contract every migrated lane verb points at, relative to the repository root. */
export const LANE_CONTRACT = "claude-plugins/fabrika/skills/operate/contract.md";

/** A lane verb's long description: summary, exit lines, then the pointer to `## \`lane <verb>\``. */
export const laneHelp = (verb: string, summary: string, exits: ExitLines): string =>
	[
		summary,
		...Object.entries(exits).map(([code, meaning]) => `  ${code}: ${meaning}`),
		`  See operate contract.md, "lane ${verb}"`,
	].join("\n");
