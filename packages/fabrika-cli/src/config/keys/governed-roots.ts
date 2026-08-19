/**
 * `governedRoots` — the roots a diff derives the `governance` namespace over.
 *
 * The shipped default is phoenix's four roots plus `.fabrika.jsonc` itself: a diff that weakens the
 * config owes a governance verdict like any other governance-corpus change.
 *
 * **That self-inclusion is enforced at load, not by convention.** A config can edit its own
 * governed-path list, so a config whose roots do not cover `.fabrika.jsonc` could un-govern itself —
 * the one change nobody would ever be asked to justify. {@link governedRootsKey}'s `refuseLoad`
 * refuses the whole load in that case, naming the key.
 *
 * This module ships the key, its default and that refusal. Threading it into `review/classes.ts` and
 * `governance scope`, and the rest of the path surface, is #6296's.
 */

import {CONFIG_PATH} from "../document.ts";
import {trimmedStrings} from "../entries.ts";
import type {Decoded, KeyGroup} from "../key-group.ts";

export const GOVERNED_ROOTS = "governedRoots";

/**
 * Phoenix's four roots, plus the config file. Kept in step with
 * `packages/fabrika-cli/src/review/classes.ts`'s `GOVERNANCE_ROOTS` until #6296 threads that site
 * onto this key and the literal goes away.
 */
export const SHIPPED_GOVERNED_ROOTS: ReadonlyArray<string> = [
	".decisions/",
	".claude/",
	".github/",
	"claude-plugins/",
	CONFIG_PATH,
];

/** A root governs a path when the path sits under it — the same prefix rule `review scope` uses. */
const governs = (roots: ReadonlyArray<string>, path: string): boolean =>
	roots.some((root) => path.startsWith(root));

const decode = (raw: unknown): Decoded<ReadonlyArray<string>> => {
	if (!Array.isArray(raw)) {
		return {_tag: "Malformed", reason: `\`${GOVERNED_ROOTS}\` is not an array`};
	}
	const roots = trimmedStrings(raw);
	if (roots === null) {
		return {
			_tag: "Malformed",
			reason: `\`${GOVERNED_ROOTS}\` holds an entry that is not a non-empty string — expected a repo-relative root`,
		};
	}
	// An empty list would read as "nothing is governed", silently disabling the gate this key drives.
	return roots.length === 0
		? {_tag: "Malformed", reason: `\`${GOVERNED_ROOTS}\` is empty — nothing would be governed`}
		: {_tag: "Value", value: roots};
};

export const governedRootsKey: KeyGroup<ReadonlyArray<string>> = {
	key: GOVERNED_ROOTS,
	shippedDefault: SHIPPED_GOVERNED_ROOTS,
	decode,
	refuseLoad: (roots) =>
		governs(roots, CONFIG_PATH)
			? null
			: `\`${GOVERNED_ROOTS}\` does not cover ${CONFIG_PATH} — a config cannot un-govern itself`,
};
