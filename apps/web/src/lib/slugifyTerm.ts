/**
 * There is no server-side slugifier — a term's slug is whatever lands in the URL. This
 * matches the existing corpus (lowercase, Turkish folded to ASCII, hyphen-joined) so a
 * user-typed term reaches a slug shaped like its peers.
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
