import {useView, type ViewRef, view} from "react-fate";
import {Link} from "react-router";
import type {Term} from "../../../worker/features/fate/views";
import {useTPlural} from "../../i18n";

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
	const tp = useTPlural();

	if (variant === "popular") {
		return (
			<li className="kp-sozluk-popular__row">
				{rank != null ? (
					<span className="kp-sozluk-popular__rank">{String(rank).padStart(2, "0")}</span>
				) : null}
				<Link className="kp-sozluk-popular__title" to={`/sozluk/${data.slug}`}>
					{data.title}
				</Link>
				<span className="kp-sozluk-popular__meta">
					{tp(data.totalScore, {one: "sozluk.voteCount.one", other: "sozluk.voteCount.other"})}
				</span>
			</li>
		);
	}

	return (
		<Link to={`/sozluk/${data.slug}`} className="kp-sozluk-term-row">
			<div>
				<div className="kp-sozluk-term-row__title">{data.title}</div>
			</div>
			<span className="kp-sozluk-term-row__count">
				{tp(data.definitionCount, {
					one: "sozluk.entryCount.one",
					other: "sozluk.entryCount.other",
				})}
			</span>
		</Link>
	);
}
