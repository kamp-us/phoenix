/** pasaport's contribution to the one fate config. See `../fate/module.ts`. */
import {list} from "@nkzw/fate/server";
import type {FateModule, FateRootsRecord} from "../fate/module.ts";
import {lists} from "./lists.ts";
import {mutations} from "./mutations.ts";
import {queries} from "./queries.ts";
import {
	accountDeletionReceiptSource,
	authorshipStandingSource,
	banStateSource,
	contributionSource,
	emailDeliveryStateSource,
	failingAddressSource,
	profileSource,
	promotionReceiptSource,
	userSource,
} from "./sources.ts";
import {
	authorshipStandingDataView,
	banStateDataView,
	failingAddressDataView,
	profileDataView,
	userDataView,
} from "./views.ts";

const roots: FateRootsRecord = {
	me: userDataView,
	profile: profileDataView,
	// The çaylak-self "yazarlığa giden yol" aggregate (#1316, epic #1202) — a query
	// root keyed on `CurrentUser` (self-only), aggregate-only (one-way-glass), behind
	// `PHOENIX_AUTHORSHIP_LOOP`. Resolved inline by the `myAuthorshipStanding` resolver.
	myAuthorshipStanding: authorshipStandingDataView,
	// The admin ban-state read (#970, epic #968) — `requireAdmin`-gated + behind
	// `phoenix-user-ban`; the `user.banState` resolver owns the gate.
	"user.banState": banStateDataView,
	// The admin failing-address roll-up (#2692, epic #2687) — `requireAdmin`-gated + behind
	// `phoenix-email-delivery-admin`; the `emailDelivery.failing` list resolver owns the gate.
	"emailDelivery.failing": list(failingAddressDataView),
};

export const fateModule = {
	queries,
	lists,
	mutations,
	sources: [
		userSource,
		profileSource,
		contributionSource,
		accountDeletionReceiptSource,
		promotionReceiptSource,
		authorshipStandingSource,
		banStateSource,
		emailDeliveryStateSource,
		failingAddressSource,
	],
	roots,
} satisfies FateModule;
