/**
 * The brand nouns that read identically in every locale (ADR 0347). One exported constant, not
 * a markdown table parsed at test time, so the invariant test has a real import edge to the
 * list it grades.
 *
 * Rows 1–10 are `.glossary/LANGUAGE.md` §3's table verbatim. The last three — yazar, çaylak,
 * kefil — are named in ADR 0347's decision text but have no §3 row yet; they are brand nouns by
 * the same rule, so they are graded the same. A later doc step reconciles the two lists.
 */
export const BRAND_NOUNS: readonly string[] = [
	"sözlük",
	"pano",
	"kampus",
	"bildir",
	"künye",
	"depo",
	"divan",
	"mecmua",
	"sustur",
	"engelle",
	"yazar",
	"çaylak",
	"kefil",
];
