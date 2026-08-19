/**
 * The claim-marker read every mutating `triage` verb runs, as scripted comment pages.
 *
 * Shared rather than repeated per verb because the guard is one module, so a test that disagrees
 * with another about the marker's shape would be testing the fixture (#5644).
 *
 * The TTL is measured against the real clock, so the two ages are written as timestamps far either
 * side of any run rather than as an injected `now` no verb accepts: {@link LIVE} cannot age out and
 * {@link EXPIRED} cannot come back.
 */
import {type FakeShell, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {markerBody} from "./claim.ts";

/** `listComments`' command line, whichever issue it names. */
export const COMMENTS = /^gh api --paginate repos\/[^ ]+\/comments\?per_page=100$/;

/** A `created_at` no TTL can have passed. */
export const LIVE = "2999-01-01T00:00:00Z";
/** A `created_at` every TTL has passed. */
export const EXPIRED = "2020-01-01T00:00:00Z";

/** One comments page carrying a claim marker per `(session, createdAt)` pair. */
export const claimPage = (
	...held: ReadonlyArray<{readonly session: string; readonly createdAt: string}>
): ExecResult =>
	okOut(
		JSON.stringify(
			held.map((row, index) => ({
				id: 900 + index,
				user: {login: "agent"},
				created_at: row.createdAt,
				updated_at: row.createdAt,
				body: markerBody(row.session),
			})),
		),
	);

/** The default every existing test gets: the issue carries no claim marker at all. */
export const UNCLAIMED: readonly [RegExp, ExecResult] = [COMMENTS, okOut("[]")];

/**
 * A spawner scripted on `script`, with the unclaimed comments page appended as the last resort.
 *
 * Appended rather than prepended so a test that scripts its own comments page still wins:
 * {@link fakeShell} resolves each call by the first pattern that matches.
 */
export const guardedShell = (script: ReadonlyArray<readonly [RegExp, ExecResult]>): FakeShell =>
	fakeShell([...script, UNCLAIMED]);
