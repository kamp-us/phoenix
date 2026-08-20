/**
 * The path surface — where this repo keeps the four files and directories fabrika reads by name.
 *
 * One module for four keys, because they are one question asked four times: the decision corpus, the
 * roadmap declaration, the cycle doc and the design harness. `governedRoots` is the fifth path key
 * and lives in `./governed-roots.ts`, which shipped ahead of this one; the two stay apart so this
 * module can be written without touching it.
 *
 * **Absent is not declined.** An absent key resolves to phoenix's current value, so a repo that
 * declares nothing behaves exactly as it does today. An explicitly declined key resolves to "this
 * repo has no such surface" and the verbs that read it degrade in the way their own contract
 * declares — which is a different answer from a path that is simply not there yet.
 *
 * Only {@link decisionsDirKey} is declinable, and the asymmetry is deliberate. A repo with no
 * decision corpus changes what `governance` may conclude and what `adr` may write, so the absence
 * has to be *declared* before those verbs will act on it (R11.1 on #5603). The other three name
 * files whose readers already answer "no such file" from the filesystem — `ui render` on a missing
 * harness, `build pick` on a missing roadmap — so a decline key there would be a second way to say
 * what the tree already says.
 */

import type {JsonSchema} from "../json-schema.ts";
import type {Decoded, KeyGroup} from "../key-group.ts";

export const DECISIONS_DIR = "decisionsDir";
export const ROADMAP_FILE_KEY = "roadmapFile";
export const CYCLE_DOC_KEY = "cycleDoc";
export const DESIGN_HARNESS_KEY = "designHarness";

/**
 * A path this repo either keeps somewhere, or states it does not keep at all.
 *
 * The two arms are a type rather than a nullable string on purpose: every reader has to answer the
 * declined case in its own words, and a `null` path is the shape that gets `?? ".decisions"`-ed back
 * into the default the repo just refused.
 */
export type PathValue =
	| {readonly _tag: "Path"; readonly path: string}
	| {readonly _tag: "Declined"};

export const atPath = (path: string): PathValue => ({_tag: "Path", path});

/** Phoenix's current values — what a repo declaring nothing still gets. */
export const SHIPPED_DECISIONS_DIR = ".decisions";
export const SHIPPED_ROADMAP_FILE = "ROADMAP.md";
export const SHIPPED_CYCLE_DOC = "product-development-cycle.md";
export const SHIPPED_DESIGN_HARNESS = "design-harness.json";

/** A repo-relative path: a non-empty string, trimmed, and never absolute or parent-relative. */
const decodePath = (key: string, raw: unknown): Decoded<string> => {
	if (typeof raw !== "string" || raw.trim() === "") {
		return {_tag: "Malformed", reason: `\`${key}\` is not a non-empty string`};
	}
	const path = raw.trim();
	if (path.startsWith("/") || path.startsWith("..")) {
		return {
			_tag: "Malformed",
			reason: `\`${key}\` is "${path}" — expected a path relative to the repository root`,
		};
	}
	return {_tag: "Value", value: path};
};

/** A repo-relative path in JSON Schema: a non-empty string, never absolute or parent-relative. */
const pathSchema = (description: string): JsonSchema => ({
	type: "string",
	description,
	minLength: 1,
	pattern: "^(?!/)(?!\\.\\.).+",
});

/** A plain path key: absent is the shipped value, and there is nothing to decline. */
const pathKey = (key: string, shipped: string, description: string): KeyGroup<string> => ({
	key,
	shippedDefault: shipped,
	decode: (raw) => decodePath(key, raw),
	jsonSchema: pathSchema(description),
});

/**
 * `decisionsDir` — the decision corpus, or `null` for a repo that keeps none.
 *
 * `null` rather than `false` or `""`: JSON already has one word for "there is no value here", and an
 * empty string would be a path the filesystem would happily resolve to the repository root.
 */
export const decisionsDirKey: KeyGroup<PathValue> = {
	key: DECISIONS_DIR,
	shippedDefault: atPath(SHIPPED_DECISIONS_DIR),
	decode: (raw) => {
		if (raw === null) return {_tag: "Value", value: {_tag: "Declined"}};
		const decoded = decodePath(DECISIONS_DIR, raw);
		return decoded._tag === "Malformed"
			? {
					_tag: "Malformed",
					reason: `${decoded.reason} — write null to declare that this repo keeps no decision corpus`,
				}
			: {_tag: "Value", value: atPath(decoded.value)};
	},
	// A readout prints what the file says, and what the file says for a declined key is `null`.
	render: (value) => (value._tag === "Declined" ? null : value.path),
	jsonSchema: {
		type: ["string", "null"],
		description:
			"The decision corpus directory, repo-relative. Write null to declare that this repo keeps no decision corpus.",
		minLength: 1,
		pattern: "^(?!/)(?!\\.\\.).+",
	},
};

export const roadmapFileKey = pathKey(
	ROADMAP_FILE_KEY,
	SHIPPED_ROADMAP_FILE,
	"The roadmap file carrying the `## Campaigns` focus table, repo-relative.",
);
export const cycleDocKey = pathKey(
	CYCLE_DOC_KEY,
	SHIPPED_CYCLE_DOC,
	"The product-development cycle doc a containment class is derived from, repo-relative.",
);
export const designHarnessKey = pathKey(
	DESIGN_HARNESS_KEY,
	SHIPPED_DESIGN_HARNESS,
	"The design-harness file declaring the dev server `ui render` renders at, repo-relative.",
);
