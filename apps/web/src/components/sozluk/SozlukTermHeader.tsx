import {useView, type ViewRef, view} from "react-fate";
import {Link} from "react-router";
import type {Term} from "../../../worker/features/fate/views";
import {toIsoOrNull} from "../../fate/wire";
import {useT, useTPlural} from "../../i18n";
import {formatAgoTR, formatDateTR} from "../../lib/datetime";

export const TermHeaderView = view<Term>()({
	id: true,
	slug: true,
	title: true,
	count: true,
	totalScore: true,
	firstAt: true,
	lastEdit: true,
});

export interface SozlukTermHeaderProps {
	term: ViewRef<"Term">;
}

export function SozlukTermHeader(props: SozlukTermHeaderProps) {
	const term = useView(TermHeaderView, props.term);
	const t = useT();
	const tp = useTPlural();
	const firstLetter = term.title.charAt(0).toLowerCase();
	const firstAt = toIsoOrNull(term.firstAt);
	const lastEdit = toIsoOrNull(term.lastEdit);
	return (
		<header className="kp-sozluk-term__head">
			<p className="kp-sozluk-term__crumbs">
				<Link to="/sozluk">{t("sozluk.term.crumbRoot")}</Link> /{" "}
				<Link to="/sozluk">{firstLetter}</Link> / {term.title}
			</p>
			<h1 className="kp-sozluk-term__title">{term.title}</h1>
			<div className="kp-sozluk-term__meta">
				<span>
					{tp(term.count, {one: "sozluk.entryCount.one", other: "sozluk.entryCount.other"})}
				</span>
				<span>
					{tp(term.totalScore, {one: "sozluk.voteCount.one", other: "sozluk.voteCount.other"})}
				</span>
				{firstAt ? <span>{t("sozluk.term.firstAt", {date: formatDateTR(firstAt)})}</span> : null}
				{lastEdit ? <span>{t("sozluk.term.lastEdit", {ago: formatAgoTR(lastEdit)})}</span> : null}
			</div>
		</header>
	);
}
