import {Link} from "react-router";
import {useT} from "../../i18n";
import {sozlukLetterHref} from "../../lib/sozlukLetterHref";

export interface SozlukTermCrumbsProps {
	/**
	 * The letter this headword files under, or an empty string / `null` when it files under
	 * none. Callers supply it, they never fold it here: the existing term reads the stored
	 * `first_letter` column and the new-term composer derives it from the slug through
	 * `sozlukLetterOf` — one markup, two sources, no private fold (#9602).
	 */
	letter: string | null;
	title: string;
}

/**
 * The term page's breadcrumb, for both of that page's branches. It lived twice — once in the
 * header, once inline in the new-term composer — and the two copies drifted: #9355 and #9331
 * each landed on the header alone, leaving the composer pointing its letter crumb at `/sozluk`
 * and naming the letter with an ASCII fold.
 */
export function SozlukTermCrumbs({letter, title}: SozlukTermCrumbsProps) {
	const t = useT();
	return (
		<p className="kp-sozluk-term__crumbs">
			<Link to="/sozluk">{t("sozluk.term.crumbRoot")}</Link> /{" "}
			{letter ? (
				<>
					<Link to={sozlukLetterHref(letter, false)}>{letter}</Link> /{" "}
				</>
			) : null}
			{title}
		</p>
	);
}
