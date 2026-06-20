/**
 * Search error-vs-empty regression guard (#549, ADR 0080). Locks in the load-bearing
 * distinction the `/search` page's `Screen` keys on: a search whose FTS read *errors*
 * (a missing `term_search` virtual table — a real misconfiguration) must surface as a
 * fate **error** (`ok:false` + a code → the "arama yapılamadı" error rail), NOT as a
 * successful empty connection (`ok:true` + zero rows → the benign "sonuç yok" state).
 *
 * #549's original premise — "a missing FTS table renders the empty-state" — was refuted
 * (the #546 investigation): the missing table raises `DrizzleError` → `orDieAccess` defect
 * (`worker/db/Drizzle.ts`, ADR 0011 infra-as-defect) → fate `INTERNAL_SERVER_ERROR`, which
 * the page's `Screen` error boundary renders as the error rail (`SearchPage.tsx`). The
 * behavior is already correct; this test guards it against a regression that would let an
 * errored read masquerade as "zero results" again. The error-vs-empty boundary is exactly
 * the `res.ok` discriminant asserted below, the same wire field `Screen` consumes.
 *
 * This belongs to the integration tier (ADR 0082): the failure mode is a real-D1
 * infrastructure fault — a dropped FTS5 virtual table — that no unit-tier fake can
 * faithfully reproduce, and the fault is injected the same setup-only, off-the-binding way
 * `setLastActivityAt` writes (Cloudflare D1 REST `execD1`), never through a fabricated
 * handler stub. The drop runs in its own per-file isolated stage + D1 (torn down by the
 * stack destroy `integrationStack` registers), so corrupting the index can never leak into
 * another file's worker — no per-test repair of the dropped table is needed.
 */
import {beforeAll, describe, expect, it} from "vitest";
import {integrationStack} from "./_integration.ts";

const h = integrationStack(import.meta.url);

const STAMP = Date.now();

beforeAll(async () => {
	// A real seeded term gives the control query a populated, well-formed index to read
	// a legitimate zero-match against — so the empty-vs-error contrast below is genuine,
	// not an artifact of an empty database.
	await h.signUp(`search549-${STAMP}-author@test.local`, "hunter2hunter2", "yazar");
	await h.seedTerm({
		slug: `search549-${STAMP}-istanbul`,
		title: "İstanbul",
		definitions: [{authorName: "yazar", body: "İstanbul gövde"}],
	});
});

describe("search error-vs-empty (#549)", () => {
	it("a legitimate zero-match query succeeds with an empty connection (the 'sonuç yok' branch)", async () => {
		// A well-formed query that matches nothing: `ok:true` with zero items. This is the
		// SUCCESS path the page renders as "sonuç yok" — it must stay distinct from the
		// error path, so a regression that collapses errors into empties is detectable.
		const res = await h.fate({
			kind: "list",
			name: "searchTerms",
			args: {query: `zzqqxx-${STAMP.toString(36)}`},
			select: ["slug", "title"],
		});
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect((res.data as {items: unknown[]}).items).toEqual([]);
		}
	});

	it("an errored FTS read (missing term_search table) surfaces as an error, not an empty result", async () => {
		// Inject the exact #546 misconfiguration: drop the `term_search` FTS5 virtual table
		// out from under the read path, so the resolver's `MATCH` raises
		// `Error: no such table: term_search` → DrizzleError → defect (ADR 0011). Setup-only
		// over the D1 REST seam (NOT the worker binding), in this file's isolated stage.
		await h.execD1("DROP TABLE IF EXISTS term_search");

		const res = await h.fate({
			kind: "list",
			name: "searchTerms",
			args: {query: "istanbul"},
			select: ["slug", "title"],
		});

		// The regression guard: the errored read is an ERROR on the wire (the field
		// `Screen` discriminates on for the "arama yapılamadı" error rail), never a
		// successful empty connection that the page would render as "sonuç yok".
		expect(res.ok).toBe(false);
		if (!res.ok) {
			// A non-empty code is what the rail prints (`arama yapılamadı: {code}`); the
			// generic `INTERNAL_SERVER_ERROR` is correct here — distinguishing the missing
			// table would mean unwrapping the deliberate infra-as-defect collapse (ADR 0011),
			// which #549 explicitly scopes OUT. We assert the error-vs-empty distinction only.
			expect(res.error.code).toBeTruthy();
		}
	});
});
