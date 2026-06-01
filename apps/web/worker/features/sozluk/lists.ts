/**
 * Sözlük root list resolvers — `terms`, `recentTerms`, `popularTerms`.
 *
 * Per ADR 0019, **root lists** resolve via custom `lists` resolvers that map a
 * service keyset page onto a `ConnectionResult`. The service owns the cursor
 * and the keyset SQL; this layer only reshapes the page. Wrapped by `fateList`
 * so the generator runs through the request runtime
 * (see `.patterns/fate-effect-bridge.md`, `.patterns/fate-connections.md`).
 *
 * `terms(sort, first, after)`:
 *   - `sort` is a plain validated string (`recent | popular`) — fate has no
 *     enum type (ADR 0018); an unknown value falls back to `recent`.
 *   - the cursor is the term slug (the keyset key, opaque to the client).
 *
 * The sözlük **home** is two distinct term connections (recent + popular)
 * rendered side by side. fate's `useRequest` keys map 1:1 to client root names
 * (`RequestResult<R,Q>` → `K extends keyof R`), and the vite plugin forces the
 * generated root name to equal the resolver name (`FateAPI['lists'][name]`), so
 * one `terms` resolver cannot be aliased under two request keys. The two thin
 * fixed-sort resolvers (`recentTerms` / `popularTerms`) give the home one
 * batched `useRequest({recentTerms, popularTerms})` — no waterfall. The
 * generic `terms(sort)` list stays for any caller that wants a single
 * configurable connection.
 */

import {fateList} from "../fate/effect.ts";
import {type KeysetPage, toConnection} from "../fate/shapers.ts";
import type {Term} from "../fate/views.ts";
import {type ListSort, Sozluk} from "./Sozluk.ts";
import {toTerm} from "./shapers.ts";
import type {TermSummaryRow} from "./term-summary.ts";

/** Coerce the `sort` arg to the service's `ListSort`; default `recent`. */
const toListSort = (value: unknown): ListSort => (value === "popular" ? "popular" : "recent");

/** Reshape a `Sozluk` term-summary page onto a `ConnectionResult<Term>`. */
const toTermConnection = (page: KeysetPage<TermSummaryRow>) =>
	// The slug cursor is the service keyset.
	toConnection(page, (row) => row.slug, toTerm);

export const lists = {
	terms: {
		type: "Term",
		resolve: fateList<{sort?: string; first?: number; after?: string}, Term>(function* ({args}) {
			const sozluk = yield* Sozluk;
			const page = yield* sozluk.listTermSummariesConnection({
				sort: toListSort(args?.sort),
				...(typeof args?.first === "number" ? {first: args.first} : {}),
				...(typeof args?.after === "string" ? {after: args.after} : {}),
			});
			return toTermConnection(page);
		}),
	},
	recentTerms: {
		type: "Term",
		resolve: fateList<{first?: number; after?: string}, Term>(function* ({args}) {
			const sozluk = yield* Sozluk;
			const page = yield* sozluk.listTermSummariesConnection({
				sort: "recent",
				...(typeof args?.first === "number" ? {first: args.first} : {}),
				...(typeof args?.after === "string" ? {after: args.after} : {}),
			});
			return toTermConnection(page);
		}),
	},
	popularTerms: {
		type: "Term",
		resolve: fateList<{first?: number; after?: string}, Term>(function* ({args}) {
			const sozluk = yield* Sozluk;
			const page = yield* sozluk.listTermSummariesConnection({
				sort: "popular",
				...(typeof args?.first === "number" ? {first: args.first} : {}),
				...(typeof args?.after === "string" ? {after: args.after} : {}),
			});
			return toTermConnection(page);
		}),
	},
};
