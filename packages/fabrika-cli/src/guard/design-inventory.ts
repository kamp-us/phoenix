/**
 * `guard design-inventory` core — extract the DESCRIPTIVE component inventory from the JSDoc on the
 * shipped `components/ui` primitives and render it as one curated-hybrid index (ADR 0194).
 *
 * **The descriptive/normative firewall is enforced here, not merely intended.** The only sanctioned
 * write target is {@link INVENTORY_ARTIFACT}, and {@link isDescriptiveWriteTarget} refuses
 * everything else — above all the founder-authored {@link NORMATIVE_MANIFEST}, whose four pillars,
 * prohibitions and role-token values must only ever change by a human's hand. The extractor path
 * routes its write through that predicate, so it can regenerate the inventory and can never rewrite
 * the law.
 *
 * IO-free: pure over already-read strings. The reads and the one write live in
 * `./design-inventory-verb.ts`.
 */

/** The one descriptive index this generates — the sole sanctioned write target. */
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
 * One primitive's descriptive contract, parsed from a single `@component` JSDoc block. `whenToUse`
 * is the inline core of the index; `source` is the link-to-source leg of the curated-hybrid idiom.
 */
export interface ComponentEntry {
	readonly component: string;
	readonly source: string;
	readonly whenToUse: string | undefined;
	readonly slots: ReadonlyArray<ComponentSlot>;
	readonly agentDirectives: ReadonlyArray<string>;
}

/**
 * The extraction verdict. A pass always carries at least one entry, and the zero-scope arm carries
 * no phantom empty list a caller could misread as "clean, nothing to document" (ADR 0092).
 */
export type InventoryResult =
	| {readonly pass: true; readonly entries: ReadonlyArray<ComponentEntry>}
	| {readonly pass: false; readonly reason: "zero-scope"};

const normalizeWhitespace = (text: string): string => text.replace(/\s+/g, " ").trim();

interface JsdocTag {
	readonly tag: string;
	readonly value: string;
}

/**
 * The inner body of every `/** … *\/` block in a file, with the per-line ` * ` decoration stripped.
 * No TS AST is needed: the metadata schema (ADR 0194) is a tag vocabulary carried in the comment
 * itself, not derived from type structure.
 */
export const extractJsdocBlocks = (content: string): ReadonlyArray<string> => {
	const blocks: Array<string> = [];
	const re = /\/\*\*([\s\S]*?)\*\//g;
	let m: RegExpExecArray | null = re.exec(content);
	while (m !== null) {
		const inner = m[1] ?? "";
		blocks.push(
			inner
				.split("\n")
				.map((line) => line.replace(/^\s*\*?\s?/, ""))
				.join("\n"),
		);
		m = re.exec(content);
	}
	return blocks;
};

/**
 * Tokenize a stripped block into ordered `@tag` groups. A line beginning `@word` opens a tag and
 * subsequent non-`@` lines fold into it; a prose lead-in before the first tag is dropped.
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

/** One block as an entry, or `null` when it carries no `@component` (it documents something else). */
export const parseComponentBlock = (block: string, source: string): ComponentEntry | null => {
	const tags = parseTags(block);
	const componentTag = tags.find((t) => t.tag === "component");
	if (!componentTag) return null;
	const component = componentTag.value.trim().split(/\s+/)[0] ?? "";
	if (component === "") return null;
	const whenToUseTag = tags.find((t) => t.tag === "whenToUse");
	return {
		component,
		source,
		whenToUse: whenToUseTag ? normalizeWhitespace(whenToUseTag.value) : undefined,
		slots: tags.filter((t) => t.tag === "slot").map((t) => parseSlot(t.value)),
		agentDirectives: tags
			.filter((t) => t.tag === "agent")
			.map((t) => normalizeWhitespace(t.value))
			.filter((v) => v !== ""),
	};
};

/** Every annotated primitive in one file — a file may declare several `@component` blocks. */
export const extractFromFile = (file: SourceFile): ReadonlyArray<ComponentEntry> =>
	extractJsdocBlocks(file.content)
		.map((block) => parseComponentBlock(block, file.path))
		.filter((e): e is ComponentEntry => e !== null);

/**
 * Build the inventory. Entries sort by `[component, source]` so the render is byte-identical
 * whatever order the filesystem hands the files back in — the property the freshness check depends
 * on. Zero primitives is fail-closed, never an empty index.
 */
export const buildInventory = (files: ReadonlyArray<SourceFile>): InventoryResult => {
	const entries = files
		.flatMap(extractFromFile)
		.slice()
		.sort((a, b) => a.component.localeCompare(b.component) || a.source.localeCompare(b.source));
	if (entries.length === 0) return {pass: false, reason: "zero-scope"};
	return {pass: true, entries};
};

const normalizeRelPath = (relPath: string): string =>
	relPath.replace(/\\/g, "/").replace(/^\.\//, "").trim();

/** The firewall predicate (ADR 0194): the inventory artifact is the only admissible write target. */
export const isDescriptiveWriteTarget = (relPath: string): boolean =>
	normalizeRelPath(relPath) === INVENTORY_ARTIFACT;

const renderEntry = (entry: ComponentEntry): string => {
	const lines: Array<string> = [`## ${entry.component}`, "", `_Source: ${entry.source}_`, ""];
	if (entry.whenToUse) lines.push(`**When to use:** ${entry.whenToUse}`, "");
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
 * The whole inventory as markdown. The header states the firewall so a reader — human or agent —
 * knows the file is descriptive-only and machine-written. No timestamp: the output must be
 * byte-stable for a given source tree, or the freshness check reds on nothing.
 */
export const renderInventory = (entries: ReadonlyArray<ComponentEntry>): string => {
	const header = [
		"# Design system — descriptive component inventory",
		"",
		"<!-- GENERATED by `fabrika guard design-inventory generate` — do not hand-edit; regenerate. -->",
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
