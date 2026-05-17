/**
 * Fragment-shaped term page header (task_4, phoenix-relay-idiom).
 *
 * Reads its data via `useFragment(SozlukTermHeaderFragment)` instead of
 * taking shaped props. The page (`SozlukTermPage`) spreads this fragment
 * into the top-level `Term` selection — the header declares what it needs.
 */
import {graphql, useFragment} from "react-relay";
import {Link} from "react-router";
import type {SozlukTermHeaderFragment$key} from "../../__generated__/SozlukTermHeaderFragment.graphql";
import {formatAgoTR, formatDateTR} from "../../lib/datetime";

const SozlukTermHeaderFragmentDef = graphql`
	fragment SozlukTermHeaderFragment on Term {
		id
		slug
		title
		count
		totalScore
		firstAt
		lastEdit
	}
`;

export interface SozlukTermHeaderProps {
	term: SozlukTermHeaderFragment$key;
}

export function SozlukTermHeader(props: SozlukTermHeaderProps) {
	const term = useFragment(SozlukTermHeaderFragmentDef, props.term);
	const firstLetter = term.title.charAt(0).toLowerCase();
	return (
		<header className="kp-sozluk-term__head">
			<p className="kp-sozluk-term__crumbs">
				<Link to="/sozluk">sözlük</Link> / <Link to="/sozluk">{firstLetter}</Link> /{" "}
				{term.title}
			</p>
			<h1 className="kp-sozluk-term__title">{term.title}</h1>
			<div className="kp-sozluk-term__meta">
				<span>{term.count} tanım</span>
				<span>{term.totalScore} oy</span>
				{term.firstAt ? <span>ilk: {formatDateTR(term.firstAt)}</span> : null}
				{term.lastEdit ? <span>son düzenleme: {formatAgoTR(term.lastEdit)}</span> : null}
			</div>
		</header>
	);
}
