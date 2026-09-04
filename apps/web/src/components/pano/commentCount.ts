import {type Locale, plural, type Translate} from "../../i18n";

/**
 * The one comment-count phrase pano renders — the feed row, the detail header and the thread
 * heading all read it here, so the plural arm is picked in one place. `tr` reports `other` for
 * every count, which is why the two Turkish arms are identical; English is where the arm bites.
 */
export function commentCountLabel(t: Translate, locale: Locale, count: number): string {
	return plural(locale, count, {
		one: t("pano.post.commentCount.one", {count}),
		other: t("pano.post.commentCount.other", {count}),
	});
}
