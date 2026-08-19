/**
 * The one grammatical shape every delegation "why the local install is unusable" clause must take.
 *
 * The loud branch's first line splices the repo root and the clause into one sentence
 * (`— ${repoRoot} ${reason}.`), so a clause carrying its own subject renders as two sentences
 * jammed together: `— /repo it has no local install.` (#6027). The rule that fixes it is that the
 * clause is a **predicate whose subject is the repo root**, never a standalone sentence.
 *
 * Grammar is not machine-checkable, so the brand does not verify the rule — it makes the rule
 * unavoidable. A producer cannot hand a bare `string` to {@link globalWarning}; it has to reach for
 * this constructor, and the rule is stated where it reaches.
 */

declare const RepoPredicateBrand: unique symbol;

/** A clause that reads as a predicate of the repo root. Built only by {@link repoPredicate}. */
export type RepoPredicate = string & {readonly [RepoPredicateBrand]: true};

/**
 * Tag a template literal as a repo-root predicate: `` repoPredicate`has no local install` ``.
 *
 * A tag rather than a plain function so the call site reads as the sentence it produces, and so the
 * interpolations stay visible in the source instead of being pre-concatenated by the caller.
 *
 * A trailing full stop is dropped because the caller supplies the one that ends the sentence, and an
 * interpolated foreign string can bring its own — `String(error)` on a Node resolution failure ends
 * in a period, which rendered as `…package.json..`.
 */
export const repoPredicate = (
	parts: TemplateStringsArray,
	...values: ReadonlyArray<string>
): RepoPredicate =>
	parts
		.reduce((text, part, index) => text + values[index - 1] + part)
		.replace(/\.$/, "") as RepoPredicate;
