/**
 * `design-inventory` pure core — extract the DESCRIPTIVE component inventory from the
 * JSDoc-on-code metadata of the shipped `components/ui` primitives, and render it into
 * one central curated-hybrid index (issue #3155, epic #3150, ADR 0194). IO-free and
 * total: every function here transforms already-read strings; the filesystem boundary
 * (enumerate + read the component files, write the artifact) lives in `gate.ts`.
 *
 * The descriptive/normative firewall (ADR 0194) is enforced in this core, not merely
 * intended: the only sanctioned write target is the descriptive inventory artifact
 * (`INVENTORY_ARTIFACT`), and `isDescriptiveWriteTarget` refuses everything else —
 * above all the founder-authored normative manifest (`NORMATIVE_MANIFEST`). The gate's
 * write routes through that predicate, so an extractor run can regenerate the inventory
 * but can never rewrite the four pillars / prohibitions / role-token values.
 *
 * Fail-closed on zero scope (ADR 0092): zero annotated primitives discovered is a broken
 * scope assumption (wrong root, a renamed dir, a dropped convention), not a vacuous pass.
 */

/** The one central descriptive index this tool generates — the sole sanctioned write target. */
export const INVENTORY_ARTIFACT = "design-system-inventory.md";

/** The founder-authored normative design law — NEVER an extractor write target (the firewall). */
export const NORMATIVE_MANIFEST = "design-system-manifest.md";

/** A source file handed to the core: its repo-relative path plus its full text. */
export interface SourceFile {
	readonly path: string;
	readonly content: string;
}

/** A `@slot` on a primitive: its name plus the one-line description the JSDoc gives it. */
export interface ComponentSlot {
	readonly name: string;
	readonly description: string;
}

/**
 * One primitive's descriptive contract, parsed from a single `@component` JSDoc block.
 * `whenToUse` is the inline core of the index; the source path is the "link to source
 * for depth" leg of the curated-hybrid idiom (props/implementation live in the file).
 * `agentDirectives` carry the protected `@agent` steering the extractor must preserve.
 */
export interface ComponentEntry {
	readonly component: string;
	readonly source: string;
	readonly whenToUse: string | undefined;
	readonly slots: ReadonlyArray<ComponentSlot>;
	readonly agentDirectives: ReadonlyArray<string>;
}

/**
 * The extraction verdict — a discriminated union so an invalid state is unrepresentable:
 * a pass always carries at least one entry, and the zero-scope failure carries no phantom
 * empty list a caller could misread as "clean, nothing to document" (ADR 0092).
 */
export type InventoryResult =
	| {readonly pass: true; readonly entries: ReadonlyArray<ComponentEntry>}
	/** No annotated primitive discovered anywhere in scope — fail closed, never a vacuous pass. */
	| {readonly pass: false; readonly reason: "zero-scope"};

/** Collapse all runs of whitespace (incl. newlines from wrapped JSDoc) to single spaces. */
const normalizeWhitespace = (text: string): string => text.replace(/\s+/g, " ").trim();

/** One JSDoc tag and its (possibly multi-line) value, in source order. */
interface JsdocTag {
	readonly tag: string;
	readonly value: string;
}

/**
 * Pull the inner body of every `/** … *\/` block comment out of a file's text, with the
 * per-line ` * ` decoration stripped. Pure over the source string — the parse never needs
 * a TS AST because the metadata schema (ADR 0194) is a lean tag vocabulary carried in the
 * doc-comment itself, not derived from type structure.
 */
export const extractJsdocBlocks = (content: string): ReadonlyArray<string> => {
	const blocks: Array<string> = [];
	const re = /\/\*\*([\s\S]*?)\*\//g;
	let m: RegExpExecArray | null = re.exec(content);
	while (m !== null) {
		const inner = m[1] ?? "";
		const stripped = inner
			.split("\n")
			.map((line) => line.replace(/^\s*\*?\s?/, ""))
			.join("\n");
		blocks.push(stripped);
		m = re.exec(content);
	}
	return blocks;
};

/**
 * Tokenize a stripped JSDoc block into ordered `@tag` groups. A line beginning `@word`
 * opens a tag; subsequent non-`@` lines are continuation text folded into the open tag's
 * value. Text before the first `@tag` (a prose lead-in) is not a tag and is dropped.
 */
const parseTags = (block: string): ReadonlyArray<JsdocTag> => {
	const tags: Array<{tag: string; parts: Array<string>}> = [];
	let current: {tag: string; parts: Array<string>} | undefined;
	for (const line of block.split("\n")) {
		const opener = /^@(\w+)\s*(.*)$/.exec(line);
		if (opener) {
			current = {tag: opener[1] ?? "", parts: [opener[2] ?? ""]};
			tags.push(current);
			continue;
		}
		if (current) current.parts.push(line);
	}
	return tags.map((t) => ({tag: t.tag, value: t.parts.join("\n")}));
};

/** Split a `@slot` value into its leading name token and the remaining description. */
const parseSlot = (value: string): ComponentSlot => {
	const trimmed = value.trim();
	const space = trimmed.search(/\s/);
	if (space === -1) return {name: trimmed, description: ""};
	return {
		name: trimmed.slice(0, space),
		description: normalizeWhitespace(trimmed.slice(space + 1)),
	};
};

/**
 * Parse one JSDoc block into a `ComponentEntry`, or `null` when the block carries no
 * `@component` tag (it documents a type/prop/module, not a primitive). The first token
 * of `@component` is the name; `@whenToUse`/`@slot`/`@agent` fill the descriptive fields.
 */
export const parseComponentBlock = (block: string, source: string): ComponentEntry | null => {
	const tags = parseTags(block);
	const componentTag = tags.find((t) => t.tag === "component");
	if (!componentTag) return null;
	const component = componentTag.value.trim().split(/\s+/)[0] ?? "";
	if (component === "") return null;

	const whenToUseTag = tags.find((t) => t.tag === "whenToUse");
	const slots = tags.filter((t) => t.tag === "slot").map((t) => parseSlot(t.value));
	const agentDirectives = tags
		.filter((t) => t.tag === "agent")
		.map((t) => normalizeWhitespace(t.value))
		.filter((v) => v !== "");

	return {
		component,
		source,
		whenToUse: whenToUseTag ? normalizeWhitespace(whenToUseTag.value) : undefined,
		slots,
		agentDirectives,
	};
};

/** Extract every annotated primitive from one file (a file may declare several `@component` blocks). */
export const extractFromFile = (file: SourceFile): ReadonlyArray<ComponentEntry> =>
	extractJsdocBlocks(file.content)
		.map((block) => parseComponentBlock(block, file.path))
		.filter((e): e is ComponentEntry => e !== null);

/**
 * Build the descriptive inventory over the read files. Entries are sorted by
 * `[component, source]` so the render is deterministic regardless of filesystem read
 * order — the property a drift guard (#3156) depends on. Fails closed on zero primitives.
 */
export const buildInventory = (files: ReadonlyArray<SourceFile>): InventoryResult => {
	const entries = files
		.flatMap(extractFromFile)
		.slice()
		.sort((a, b) => a.component.localeCompare(b.component) || a.source.localeCompare(b.source));
	if (entries.length === 0) return {pass: false, reason: "zero-scope"};
	return {pass: true, entries};
};

/** Normalize a repo-relative path for firewall comparison (drop a leading `./`, unify separators). */
const normalizeRelPath = (relPath: string): string =>
	relPath.replace(/\\/g, "/").replace(/^\.\//, "").trim();

/**
 * The firewall predicate (ADR 0194): the ONLY sanctioned write target is the descriptive
 * inventory artifact. Everything else is refused — above all the normative manifest, whose
 * four pillars / prohibitions / role-token values stay founder-authored and out of the
 * extractor's reach. The gate's write routes through this; a test proves the manifest is refused.
 */
export const isDescriptiveWriteTarget = (relPath: string): boolean =>
	normalizeRelPath(relPath) === INVENTORY_ARTIFACT;

/** Render one entry's section of the index — when-to-use inline, source linked for depth. */
const renderEntry = (entry: ComponentEntry): string => {
	const lines: Array<string> = [`## ${entry.component}`, "", `_Source: ${entry.source}_`, ""];
	if (entry.whenToUse) {
		lines.push(`**When to use:** ${entry.whenToUse}`, "");
	}
	if (entry.slots.length > 0) {
		lines.push("**Slots:**");
		for (const slot of entry.slots) {
			lines.push(
				slot.description ? `- \`${slot.name}\` — ${slot.description}` : `- \`${slot.name}\``,
			);
		}
		lines.push("");
	}
	if (entry.agentDirectives.length > 0) {
		lines.push("**Agent directives (`@agent` — protected, do not regenerate):**");
		for (const directive of entry.agentDirectives) lines.push(`- ${directive}`);
		lines.push("");
	}
	return lines.join("\n").trimEnd();
};

/**
 * Render the whole descriptive inventory to markdown — the curated-hybrid index of ADR
 * 0194 (inline the when-to-use core, link to source for depth, the effect-smol `LLMS.md`
 * idiom). The header states the firewall so a reader (human or agent) knows this file is
 * descriptive-only and machine-generated. No timestamp: the output must be byte-stable
 * for a given source tree so a drift guard (#3156) reds only on real drift.
 */
export const renderInventory = (entries: ReadonlyArray<ComponentEntry>): string => {
	const header = [
		"# Design system — descriptive component inventory",
		"",
		"<!-- GENERATED by `pipeline-cli design-inventory generate` — do not hand-edit; regenerate. -->",
		"",
		"The descriptive half of the design docs (ADR 0194): which `components/ui` primitives",
		"exist, their slots, and each one's when-to-use — extracted from the JSDoc on the shipped",
		"components. It is DESCRIPTIVE ONLY. The normative design law — the four pillars, the",
		"prohibitions, and the role-token values — is founder-authored in",
		"[`design-system-manifest.md`](design-system-manifest.md) and is never written here. A",
		"when-to-use references that law; it never restates or mints it.",
		"",
	].join("\n");
	return `${header}\n${entries.map(renderEntry).join("\n\n")}\n`;
};
