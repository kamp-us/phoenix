/**
 * Sözlük root list resolvers — `terms`, `recentTerms`, `popularTerms`. Root
 * lists map a service keyset page onto a `ConnectionResult` (ADR 0019; the
 * service owns the cursor + keyset SQL, this layer only reshapes). `sort` is a
 * plain validated string since fate has no enum type (ADR 0018).
 *
 * `recentTerms` / `popularTerms` exist as fixed-sort duplicates of `terms`
 * because fate's `useRequest` keys map 1:1 to root names — one `terms` resolver
 * can't be aliased under two keys, so the home page (recent + popular side by
 * side) needs two resolvers to batch them in one request without a waterfall.
 */

import {Fate} from "@kampus/fate-effect";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {type KeysetPage, toConnection} from "../fate/connection.ts";
import {type ListSort, Sozluk} from "./Sozluk.ts";
import {toTerm} from "./shapers.ts";
import type {TermSummaryRow} from "./term-summary.ts";
import {TermView} from "./views.ts";

const toListSort = (value: string | undefined): ListSort =>
	value === "popular" ? "popular" : "recent";

const pageArgs = {
	first: Schema.optional(Schema.Number),
	after: Schema.optional(Schema.String),
};

const TermsArgs = Schema.Struct({sort: Schema.optional(Schema.String), ...pageArgs});
const TermPageArgs = Schema.Struct(pageArgs);

const LANDING_TERMS_DEFAULT = 5;
const LandingTermsArgs = Schema.Struct({first: Schema.optional(Schema.Number)});

const toTermConnection = (page: KeysetPage<TermSummaryRow>) =>
	toConnection(page, (row) => row.slug, toTerm);

const listTerms = (
	sort: ListSort,
	args: {first?: number | undefined; after?: string | undefined},
) =>
	Effect.gen(function* () {
		const sozluk = yield* Sozluk;
		const page = yield* sozluk.listTermSummariesConnection({
			sort,
			...(args.first !== undefined ? {first: args.first} : {}),
			...(args.after !== undefined ? {after: args.after} : {}),
		});
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
	// The public landing "son eklenenler" column (#1424) — live-only recent terms,
	// masked in `Sozluk.getLandingTerms`; a single non-paginated page.
	landingTerms: Fate.list(
		{args: LandingTermsArgs, type: TermView},
		Effect.fn("landingTerms")(function* ({args}) {
			const sozluk = yield* Sozluk;
			const rows = yield* sozluk.getLandingTerms(args.first ?? LANDING_TERMS_DEFAULT);
			return toTermConnection({rows, hasNextPage: false, endCursor: null});
		}),
	),
};
