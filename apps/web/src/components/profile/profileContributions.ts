// The two profile surfaces share this copy. The heading is the one intentional
// divergence — third-person `katkılar` on someone else's profile, second-person
// `katkıların` on the owner's own — named here so it reads as a choice, not the
// accidental drift #2203 found.

export const CONTRIBUTIONS_HEADING = {
	public: "katkılar",
	self: "katkıların",
} as const;

export const CONTRIBUTIONS_EMPTY = {
	title: "henüz katkı yok.",
	description: "ilk tanımını ya da başlığını ekleyince burada görünür.",
} as const;
