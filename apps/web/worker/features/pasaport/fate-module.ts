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
	roleStateSource,
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
	// Keyed on `CurrentUser` (self-only), aggregate-only — the one-way-glass read (#1316).
	myAuthorshipStanding: authorshipStandingDataView,
	// `requireAdmin`-gated + behind `phoenix-user-ban`; the resolver gates.
	"user.banState": banStateDataView,
	// `requireAdmin`-gated + behind `phoenix-email-delivery-admin`; the resolver gates.
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
		roleStateSource,
		emailDeliveryStateSource,
		failingAddressSource,
	],
	roots,
} satisfies FateModule;
