/**
 * Sozluk home term row (task_5, phoenix-relay-idiom).
 *
 * Reads via `useFragment` against `TermRowFragment on Term` — the home
 * page's two `@connection`-shaped fragments hand each edge's `node` ref
 * to this component, which stays oblivious to which connection
 * (`SozlukHome__recentTerms` / `SozlukHome__popularTerms`) the row came
 * from. Two render variants, one fragment: `recent` shows title + count;
 * `popular` shows rank + title + total score. The fragment's field set is
 * the union of what both variants need (id, slug, title, definitionCount,
 * totalScore, lastActivityAt, firstLetter) so the row component never
 * masks a field a column wants.
 */
import {graphql, useFragment} from "react-relay";
import {Link} from "react-router";
import type {TermRowFragment$key} from "../../__generated__/TermRowFragment.graphql";

const TermRowFragmentDef = graphql`
	fragment TermRowFragment on Term {
		id
		slug
		title
		definitionCount
		totalScore
		lastActivityAt
		firstLetter
	}
`;

export interface TermRowProps {
	term: TermRowFragment$key;
	variant?: "recent" | "popular";
	rank?: number;
}

export function TermRow({term, variant = "recent", rank}: TermRowProps) {
	const data = useFragment(TermRowFragmentDef, term);

	if (variant === "popular") {
		return (
			<li className="kp-sozluk-popular__row">
				{rank != null ? (
					<span className="kp-sozluk-popular__rank">{String(rank).padStart(2, "0")}</span>
				) : null}
				<Link className="kp-sozluk-popular__title" to={`/sozluk/${data.slug}`}>
					{data.title}
				</Link>
				<span className="kp-sozluk-popular__meta">{data.totalScore} ↑</span>
			</li>
		);
	}

	return (
		<Link to={`/sozluk/${data.slug}`} className="kp-sozluk-term-row">
			<div>
				<div className="kp-sozluk-term-row__title">{data.title}</div>
			</div>
			<span className="kp-sozluk-term-row__count">{data.definitionCount} tanım</span>
		</Link>
	);
}
