/**
 * The amendment envelope — the bytes `report amend` puts between a filed body and its addendum.
 *
 * GitHub keeps no issue-body history, so a body that is replaced is a body that is gone. Every
 * write here is therefore an append: the prior body survives verbatim above the separator, and the
 * verb composes the separator and the dated heading itself so no caller invents its own envelope
 * and two amendments on one issue read as two different documents.
 */

/** The rule that separates the prior body from the amendment. */
export const SEPARATOR = "---";

/**
 * The dated heading each amendment opens with, on the `## Amendment` form pinned by
 * `claude-plugins/fabrika/skills/build/references/prose.md`.
 */
export const heading = (on: Date): string => `## Amendment — ${on.toISOString().slice(0, 10)}`;

export interface Amendment {
	/** The whole body to PATCH: the prior body, the envelope, then the section. */
	readonly body: string;
	/** The envelope plus the section — what the read-back must find. */
	readonly appended: string;
}

/**
 * Append `section` to `prior` under a dated amendment heading.
 *
 * A body that is empty or blank gets the amendment alone: a separator ruling off nothing renders as
 * a stray horizontal rule, and there is no prior text for it to separate.
 */
export const compose = (prior: string, section: string, on: Date): Amendment => {
	const above = prior.replace(/\s+$/, "");
	const appended = `${above === "" ? "" : `${SEPARATOR}\n\n`}${heading(on)}\n\n${section.trim()}\n`;
	return {body: above === "" ? appended : `${above}\n\n${appended}`, appended};
};
