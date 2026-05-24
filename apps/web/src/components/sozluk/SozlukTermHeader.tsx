/**
 * fate-shaped term page header.
 *
 * Reads its data via `useView(TermHeaderView, ref)` — the term page composes
 * `TermHeaderView` into its `term` request item and hands the `Term` ref down.
 * The header declares the fields it needs; fate masks the rest.
 */
import {useView, type ViewRef, view} from "react-fate";
import {Link} from "react-router";
import type {Term} from "../../../worker/fate/views";
import {formatAgoTR, formatDateTR} from "../../lib/datetime";

/** The fields the term header reads. Co-located with the component. */
export const TermHeaderView = view<Term>()({
	id: true,
	slug: true,
	title: true,
	count: true,
	totalScore: true,
	firstAt: true,
	lastEdit: true,
});

/** Wire dates arrive as strings though the entity type says `Date`. */
const toIso = (value: Date | string | null | undefined): string | null =>
	value == null ? null : value instanceof Date ? value.toISOString() : String(value);

export interface SozlukTermHeaderProps {
	term: ViewRef<"Term">;
}

export function SozlukTermHeader(props: SozlukTermHeaderProps) {
	const term = useView(TermHeaderView, props.term);
	const firstLetter = term.title.charAt(0).toLowerCase();
	const firstAt = toIso(term.firstAt);
	const lastEdit = toIso(term.lastEdit);
	return (
		<header className="kp-sozluk-term__head">
			<p className="kp-sozluk-term__crumbs">
				<Link to="/sozluk">sözlük</Link> / <Link to="/sozluk">{firstLetter}</Link> / {term.title}
			</p>
			<h1 className="kp-sozluk-term__title">{term.title}</h1>
			<div className="kp-sozluk-term__meta">
				<span>{term.count} tanım</span>
				<span>{term.totalScore} oy</span>
				{firstAt ? <span>ilk: {formatDateTR(firstAt)}</span> : null}
				{lastEdit ? <span>son düzenleme: {formatAgoTR(lastEdit)}</span> : null}
			</div>
		</header>
	);
}
