/**
 * The product names that read identically in every locale (ADR 0414, amending ADR 0347). One
 * exported constant, not a markdown table parsed at test time, so the invariant test has a real
 * import edge to the list it grades.
 */
export const BRAND_NOUNS: readonly string[] = ["sözlük", "pano", "kampus", "mecmua", "depo"];

/**
 * The Turkish words the English catalog translates (ADR 0414): divan reads "Council", künye reads
 * "Standing", the rest take their plain English word. Graded as word stems, so a suffixed form
 * (`çaylaklar`, `künyesi`) counts too.
 */
export const TRANSLATED_IN_ENGLISH: readonly string[] = [
	"divan",
	"künye",
	"yazar",
	"çaylak",
	"kefil",
	"bildir",
	"sustur",
	"engelle",
];
