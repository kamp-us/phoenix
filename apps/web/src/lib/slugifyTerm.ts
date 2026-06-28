/**
 * Slugify a free-text term into the kebab-case slug the sözlük URL/`/sozluk/:slug`
 * route uses. There is no server-side slugifier — a term's slug is whatever lands
 * in the URL, and the existing corpus is lowercase, ASCII-folded, hyphen-joined
 * (`önbellek` → `onbellek`, `yatay ölçekleme` → `yatay-olcekleme`).
 * The create affordance routes to `/sozluk/<slugifyTerm(query)>` so a user-typed
 * term reaches the existing fresh-slug composer with a slug shaped like its peers.
 */

const TURKISH_FOLD: Record<string, string> = {
	ç: "c",
	ğ: "g",
	ı: "i",
	ö: "o",
	ş: "s",
	ü: "u",
	i: "i",
};

export function slugifyTerm(input: string): string {
	return input
		.toLocaleLowerCase("tr-TR")
		.replace(/[çğıöşüi]/g, (ch) => TURKISH_FOLD[ch] ?? ch)
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}
