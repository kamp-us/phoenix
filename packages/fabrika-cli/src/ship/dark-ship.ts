/**
 * Dark-ship detection: three ground-truth signals over the PR itself, any one sufficient.
 *
 * The linked issue's inherited `Containment:` stamp is **never** read — it describes the epic, not
 * this PR, and reading it queued a phantom release (#1257).
 *
 * Signal (c) is the one with two edges, and both are named because losing either is a real defect:
 * a **reused** flag declared by an earlier PR is a real dark ship this must catch (#2086), while a
 * **prose mention** of an old flag must not mint a phantom one (#2897/#2843). The context scoping —
 * fenced code stripped, whole-token match, gating word required on the line — is what separates
 * them.
 */

/** The module a flag declaration must live in for signal (a) to fire. */
export const FLAG_REGISTRY = "apps/web/worker/features/flagship/resources.ts";

const KEBAB = "[a-z0-9]+(?:-[a-z0-9]+)+";

/** `Flag: <key>` / `Flag key: <key>`, heading and bold markers tolerated. */
const BODY_FLAG_LINE = new RegExp(
	// The bold markers are admitted on either side of the colon: `**Flag key:**` and `**Flag key**:`
	// are the same claim, and a matcher that reads only one of them silently misses a real dark ship.
	`^[ \t>#*]*\\*{0,2}Flag(?: key)?\\*{0,2}[ \t]*:\\*{0,2}[ \t]*\`?(${KEBAB})\`?`,
	"im",
);

/** The words that make a line a *gating* claim rather than a mention. */
const GATING = /\b(?:gate[ds]?|gating|behind|flag(?:ged)?|default-off|dark[- ]ship)\b/i;

/** Fenced code carries examples and diffs — a key quoted there is not a claim about this PR. */
export const stripFences = (body: string): string => body.replace(/```[\s\S]*?```/g, "");

/** Signal (a): this diff ADDS a declaration to the registry module. */
export const addsDeclaration = (diff: string): boolean => {
	let inRegistry = false;
	for (const line of diff.split("\n")) {
		if (line.startsWith("diff --git ")) inRegistry = line.includes(FLAG_REGISTRY);
		if (!inRegistry || !line.startsWith("+") || line.startsWith("+++")) continue;
		if (/FlagshipFlag\(|defaultVariation:/.test(line)) return true;
	}
	return false;
};

/** Signal (b): the PR body declares the key outright. */
export const declaredKeyOf = (body: string): string | null => {
	const matched = BODY_FLAG_LINE.exec(stripFences(body));
	return matched?.[1] ?? null;
};

/** Every kebab-case key the registry module declares at the base branch. */
export const declaredKeysIn = (registry: string): ReadonlyArray<string> => {
	const keys = new Set<string>();
	const pattern = new RegExp(`["'\`](${KEBAB})["'\`]`, "g");
	for (const line of registry.split("\n")) {
		if (!/FlagshipFlag\(/.test(line)) continue;
		for (const match of line.matchAll(pattern)) {
			if (match[1] !== undefined) keys.add(match[1]);
		}
	}
	return [...keys];
};

/** Signal (c): the body names a declared key on a line that claims gating. */
export const referencedKeyOf = (body: string, declared: ReadonlyArray<string>): string | null => {
	for (const line of stripFences(body).split("\n")) {
		if (!GATING.test(line)) continue;
		for (const key of declared) {
			if (new RegExp(`(?:^|[^a-z0-9-])${key}(?![a-z0-9-])`).test(line)) return key;
		}
	}
	return null;
};

export interface DarkShip {
	readonly dark: boolean;
	/** The key the report prints. `null` only when signal (a) fired without naming one. */
	readonly key: string | null;
}

export const detect = (diff: string, body: string, registry: string): DarkShip => {
	const declared = declaredKeyOf(body);
	if (declared !== null) return {dark: true, key: declared};
	const referenced = referencedKeyOf(body, declaredKeysIn(registry));
	if (referenced !== null) return {dark: true, key: referenced};
	return addsDeclaration(diff) ? {dark: true, key: null} : {dark: false, key: null};
};
