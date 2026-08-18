/**
 * The `## Came from` section — the one line that says which issue an artifact's question arrived
 * from, and the only thing that carries a wayfinding frontier ticket number into a sibling skill.
 *
 * Both siblings `map fork` routes to write it: `spike open` records it on the spike issue and
 * `grill open` records it on the session issue. It lives here rather than in either group because a
 * grammar with two writers and one reader is exactly where a reader drifts from a writer — and the
 * drift reads as "this session came from nowhere", which is the silent state this section exists to
 * prevent.
 *
 * **The section is provenance, never instruction.** A number here says where the question came from;
 * it grants nothing and no verb reads the named issue for direction.
 */

/** The heading the section opens with. A drifted level or spelling is not this section. */
export const CAME_FROM_HEADING = "## Came from";

/** What an unbound artifact records. A blank value would read as a section nobody filled in. */
export const STANDALONE = "standalone";

/** The section's value line: the ticket, or the literal `standalone`. */
export const renderCameFrom = (ticket: number | null): string =>
	ticket === null ? STANDALONE : `#${ticket}`;

/** The whole section, heading and value, ending in one newline. */
export const cameFromSection = (ticket: number | null): string =>
	`${CAME_FROM_HEADING}\n\n${renderCameFrom(ticket)}\n`;

const TICKET_LINE = /^#(\d+)$/;

/**
 * The ticket the body is bound to, or `null` for `standalone`, an absent section, and any value
 * that is not an issue reference.
 *
 * Total on purpose: the caller that matters — `grill open`'s resume — is deciding whether *this*
 * session is the one bound to a ticket it already holds, and no unparsable body should ever answer
 * that question with a number.
 */
export const readCameFrom = (body: string): number | null => {
	const lines = body.split("\n");
	const heading = lines.findIndex((line) => line.trim() === CAME_FROM_HEADING);
	if (heading < 0) return null;
	const value = lines.slice(heading + 1).find((line) => line.trim() !== "");
	const matched = TICKET_LINE.exec((value ?? "").trim());
	return matched === null ? null : Number.parseInt(matched[1] ?? "0", 10);
};
