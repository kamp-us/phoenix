/** pasaport's contribution to the one fate config. See `../fate/module.ts`. */
import type {FateModule, FateRootsRecord} from "../fate/module.ts";
import {mutations} from "./mutations.ts";
import {queries} from "./queries.ts";
import {
	accountDeletionReceiptSource,
	authorshipStandingSource,
	contributionSource,
	profileSource,
	promotionReceiptSource,
	userSource,
} from "./sources.ts";
import {authorshipStandingDataView, profileDataView, userDataView} from "./views.ts";

const roots: FateRootsRecord = {
	me: userDataView,
	profile: profileDataView,
	// The çaylak-self "yazarlığa giden yol" aggregate (#1316, epic #1202) — a query
	// root keyed on `CurrentUser` (self-only), aggregate-only (one-way-glass), behind
	// `PHOENIX_AUTHORSHIP_LOOP`. Resolved inline by the `myAuthorshipStanding` resolver.
	myAuthorshipStanding: authorshipStandingDataView,
};

export const fateModule = {
	queries,
	mutations,
	sources: [
		userSource,
		profileSource,
		contributionSource,
		accountDeletionReceiptSource,
		promotionReceiptSource,
		authorshipStandingSource,
	],
	roots,
} satisfies FateModule;
