/**
 * What a changed markdown file's leak scan owes this PR — the leaks it carries **minus** the ones it
 * already carried at the merge base.
 *
 * **The shape is a merge-base baseline, and `cli-invocation-guard` reached the same one** for the
 * same class of problem in #4250 — a guard must not red a PR for a violation it neither introduced
 * nor can fix. Its `attribute()` classifies each head finding against the merge base's findings,
 * keyed on file plus the exact offending text with the line number deliberately dropped, consumed
 * as a multiset budget. That is this module, with the file folded into the key. The convergence is
 * the argument for the pick: two guards written years apart against the same problem landed on the
 * same three properties.
 *
 * The alternative — read the diff hunks and keep only findings on added lines — is rejected for one
 * reason: a markdown file is edited by rewriting prose, and a moved paragraph, a re-wrapped line or
 * a rename presents every carried line as added. The shape that fixes the false red would reproduce
 * it on the most ordinary doc edit there is. A baseline compares content, so a line that merely
 * *moved* is still the base's line.
 *
 * The baseline is keyed by path, so a **rename reds every leak the file already carried**: there is
 * no base text at the new path, and the whole content is this diff's. That is the intended answer —
 * a doc moved into a new home is a fresh chance to fix what it carries — but it is the one case
 * where "predates this diff" and "predates this path" part ways, so read a rename's reds as new.
 *
 * The other place the baseline runs looser than the gate it predicts: **the base text is scanned
 * with the *head's* exemption list**, so a diff that removes a doc from `.fabrika.jsonc`'s
 * `docLeakExempt` makes that doc's pre-existing leaks appear on both sides and cancel. This
 * predictor greens; `leak-guard.yml`, which scans every changed file whole and is unbypassable,
 * still reds it. Scanning the base with the base's list would fix the prediction, at the cost of a
 * second config read against a tree the verb otherwise never parses — not worth it while the
 * authoritative gate is the one that decides.
 *
 * The cost of comparing content is that a leak has no stable line number across an edit — an
 * insertion above shifts every line below it — so identity has to drop the line and become the
 * pattern's reason plus the matched bytes. Two byte-identical leaks in one file therefore look the
 * same, which is why the difference is a **multiset** one: the base's copies are a budget the head's
 * occurrences spend, and the first occurrence past the budget reds. Adding a third copy of a leak
 * the base held twice is still an introduced leak.
 *
 * **Only the leak scan is baselined.** A leak is decided entirely by the bytes of its own line, so
 * "present unchanged at the base" is a complete reason to attribute it elsewhere. The prose
 * surface's other validator, the relative-link resolver, is not: a link's resolvability is a
 * property of the *tree*, and the same untouched line flips from resolving to dead the moment the
 * diff deletes or moves its target. Baselining that would green the PR that broke every link in the
 * repo, which is the one defect the resolver exists to catch.
 */
import type {DocLeak} from "./doc-leaks.ts";

/**
 * A leak's identity across an edit: the reason and the bytes, never the line an edit above shifts.
 *
 * Keyed as a JSON pair rather than a delimited string: no separator means no separator to collide
 * with, and no non-printing byte in this file's source (a raw NUL here made git call the whole
 * module binary, so no diff of it could be read — #6215).
 */
const identity = (leak: DocLeak): string => JSON.stringify([leak.reason, leak.matched]);

/**
 * The leaks `head` carries beyond what `base` already carried, in head order.
 *
 * A multiset difference: each base occurrence cancels one head occurrence of the same identity, and
 * what survives is what this diff added.
 */
export const introducedLeaks = (
	base: ReadonlyArray<DocLeak>,
	head: ReadonlyArray<DocLeak>,
): ReadonlyArray<DocLeak> => {
	const budget = new Map<string, number>();
	for (const leak of base) {
		const key = identity(leak);
		budget.set(key, (budget.get(key) ?? 0) + 1);
	}
	return head.filter((leak) => {
		const key = identity(leak);
		const left = budget.get(key) ?? 0;
		if (left === 0) return true;
		budget.set(key, left - 1);
		return false;
	});
};
