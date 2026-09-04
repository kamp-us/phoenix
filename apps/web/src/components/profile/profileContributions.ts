// The two profile surfaces share this copy. The heading is the one intentional
// divergence — third-person `katkılar` on someone else's profile, second-person
// `katkıların` on the owner's own — named here so it reads as a choice, not the
// accidental drift #2203 found.

import type {CatalogKey} from "../../i18n/keys";

export const CONTRIBUTIONS_HEADING_KEYS = {
	public: "profile.contributions.heading.public",
	self: "profile.contributions.heading.self",
} as const satisfies Record<"public" | "self", CatalogKey>;

export const CONTRIBUTIONS_EMPTY_KEYS = {
	title: "profile.contributions.empty.title",
	description: "profile.contributions.empty.description",
} as const satisfies Record<"title" | "description", CatalogKey>;
