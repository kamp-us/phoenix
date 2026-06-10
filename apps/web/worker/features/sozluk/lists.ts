/**
 * Sözlük root list resolvers — `terms`, `recentTerms`, `popularTerms`.
 *
 * Per ADR 0019, **root lists** resolve via custom `lists` resolvers that map a
 * service keyset page onto a `ConnectionResult`. The service owns the cursor
 * and the keyset SQL; this layer only reshapes the page. Each is a `Fate.list`
 * def + `Effect.fn` pair (`.patterns/fate-effect-operations.md`,
 * `.patterns/fate-connections.md`).
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

import {Fate} from "@phoenix/fate-effect";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {orDieDrizzle} from "../../db/Drizzle.ts";
import {type KeysetPage, toConnection} from "../fate/shapers.ts";
import {type ListSort, Sozluk} from "./Sozluk.ts";
import {toTerm} from "./shapers.ts";
import type {TermSummaryRow} from "./term-summary.ts";
import {TermView} from "./views.ts";

/** Coerce the `sort` arg to the service's `ListSort`; default `recent`. */
const toListSort = (value: string | undefined): ListSort =>
	value === "popular" ? "popular" : "recent";

/** Forward keyset pagination args, shared by all three term lists. */
const pageArgs = {
	first: Schema.optional(Schema.Number),
	after: Schema.optional(Schema.String),
};

const TermsArgs = Schema.Struct({sort: Schema.optional(Schema.String), ...pageArgs});
const TermPageArgs = Schema.Struct(pageArgs);

/** Reshape a `Sozluk` term-summary page onto a `ConnectionResult<Term>`. */
const toTermConnection = (page: KeysetPage<TermSummaryRow>) =>
	// The slug cursor is the service keyset.
	toConnection(page, (row) => row.slug, toTerm);

/** The shared handler body: one keyset page at a fixed-or-passed sort. */
const listTerms = (
	sort: ListSort,
	args: {first?: number | undefined; after?: string | undefined},
) =>
	Effect.gen(function* () {
		const sozluk = yield* Sozluk;
		const page = yield* sozluk
			.listTermSummariesConnection({
				sort,
				...(args.first !== undefined ? {first: args.first} : {}),
				...(args.after !== undefined ? {after: args.after} : {}),
			})
			.pipe(orDieDrizzle);
		return toTermConnection(page);
	});

export const lists = {
	terms: Fate.list(
		{args: TermsArgs, type: TermView},
		Effect.fn("terms")(function* ({args}) {
			return yield* listTerms(toListSort(args.sort), args);
		}),
	),
	recentTerms: Fate.list(
		{args: TermPageArgs, type: TermView},
		Effect.fn("recentTerms")(function* ({args}) {
			return yield* listTerms("recent", args);
		}),
	),
	popularTerms: Fate.list(
		{args: TermPageArgs, type: TermView},
		Effect.fn("popularTerms")(function* ({args}) {
			return yield* listTerms("popular", args);
		}),
	),
};
