/**
 * `triage split`'s create-once key and the child body that carries it, pure.
 *
 * **The key is one the verb wrote, not one a caller remembered.** The child body carries
 * `split from #<parent>`, so a re-run reads back the same evidence it planted. The predecessor
 * called that back-reference load-bearing and then never checked the body carried it, so a child
 * filed without it was permanently invisible to the guard and every re-run fired a fresh twin
 * (#3462/#3463).
 *
 * **Both halves, never one.** A candidate matches on `(back-reference AND normalized title)`. The
 * back-reference alone collapses every sibling of one parent into the first child ever split from it;
 * the title alone collapses same-titled children of unrelated parents. Each half alone is a silent
 * lost split, which is the direction this verb is least allowed to fail in.
 */

import {composeBody} from "../report/compose.ts";

/**
 * The title, reduced to the form the key compares — **Unicode-aware**, not ASCII.
 *
 * `\p{L}\p{N}` is the load-bearing part. An ASCII class shreds a Turkish title into a handful of
 * fragments, so two genuinely different Turkish-titled siblings of one parent collapse to the same
 * key and the second is falsely *reused* — a split silently lost, against a corpus whose product
 * titles are Turkish by repo law (`.glossary/LANGUAGE.md`). NFC folds canonically-equivalent
 * spellings of one title together, which can only remove twins, never merge distinct titles.
 */
export const normalizeTitle = (title: string): string =>
	title
		.normalize("NFC")
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((token) => token !== "")
		.join(" ");

/** The line the child body carries, and the thing a later run greps for. */
export const backReference = (parent: number): string => `split from #${parent}`;

/**
 * Whether `body` carries the back-reference to `parent`.
 *
 * The trailing-digit guard is what keeps `split from #431` from answering for `#43` — a false match
 * there reuses an unrelated child and drops the split.
 */
export const hasBackReference = (body: string, parent: number): boolean =>
	new RegExp(`split from #${parent}(?!\\d)`, "i").test(body);

/** One issue as the create-once match reads it. */
export interface Candidate {
	readonly number: number;
	readonly title: string;
	readonly body: string;
	readonly url: string;
}

/** Whether `candidate` is already this split's child — both halves of the key, AND-ed. */
export const isExistingChild = (candidate: Candidate, parent: number, title: string): boolean =>
	hasBackReference(candidate.body, parent) &&
	normalizeTitle(candidate.title) === normalizeTitle(title);

/**
 * The child body: the caller's bytes, the back-reference, then the agent footer.
 *
 * The footer is not decoration. Without it `triage provenance` answers `human` and `triage kill`
 * refuses the child forever on `12` — a split child could never be killed, not even as a duplicate
 * of its own sibling (ADR 0159). `composeBody` owns the spacing so this shape stays identical to
 * `report file`'s.
 */
export const composeChildBody = (stdin: string, parent: number, footer: string): string =>
	composeBody(`${stdin.replace(/\s+$/, "")}\n\n${backReference(parent)}`, footer);

/** The comment the parent gets, so the provenance trace is part of the operation, not the model's. */
export const crossLinkComment = (child: number): string => `split into #${child}`;
