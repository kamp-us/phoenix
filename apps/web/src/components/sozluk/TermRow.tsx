/**
 * Sözlük home term row, fate-shaped.
 *
 * Reads via `useView(TermRowView, ref)` — the home's two connections
 * (`recentTerms` / `popularTerms`) hand each node `ViewRef` to this component,
 * which stays oblivious to which column it lives in. Two render variants, one
 * view: `recent` shows title + count; `popular` shows rank + title + total
 * score. The view's field set is the union both variants need.
 */
import {useView, type ViewRef, view} from "react-fate";
import {Link} from "react-router";
import type {Term} from "../../../worker/features/fate/views";

/** The fields a term row reads (union of both column variants). */
export const TermRowView = view<Term>()({
	id: true,
	slug: true,
	title: true,
	definitionCount: true,
	totalScore: true,
	lastActivityAt: true,
	firstLetter: true,
});

export interface TermRowProps {
	term: ViewRef<"Term">;
	variant?: "recent" | "popular";
	rank?: number;
}

export function TermRow({term, variant = "recent", rank}: TermRowProps) {
	const data = useView(TermRowView, term);

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
