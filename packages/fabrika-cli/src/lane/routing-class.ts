/**
 * The routing-only lane class — a name a `class:<name>` arm guards on and no producer writes.
 *
 * A mixed lane is one whose deliverable spans a rendered surface and text, and it has to reach the
 * shell carrying both construction laws on every round. The standing set already says so: `ui`
 * beside a text class, off the ticket's labels before a head exists and off the head's diff after.
 * So `mixed` is read from that set rather than stored in it. A written `mixed` would be cleared by
 * the first relay of a head's classes, which replaces the standing set outright and derives only
 * the classes a diff partitions to — and the repair round after it would land in a single-law shell.
 *
 * It stays out of `SHIP_CLASS_NAMES` for the same reason it is not written: that list is the
 * required-namespace set the merge gate enforces, and no reviewer emits a verdict for `mixed`.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/6900
 */
import {CLASS_NAMES} from "../review/classes.ts";

export const MIXED_CLASS = "mixed";

const RENDERED_CLASS = "ui";

/** Whether `name` stands over a task carrying `standing` — membership, except for the derived one. */
export const classStands = (standing: ReadonlyArray<string>, name: string): boolean =>
	name === MIXED_CLASS
		? standing.includes(RENDERED_CLASS) && CLASS_NAMES.some((text) => standing.includes(text))
		: standing.includes(name);
