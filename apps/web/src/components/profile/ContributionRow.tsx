// `Contribution` is a single discriminant view (ADR 0018): one node carries `kind`
// plus the nullable union of all three variants' fields, so this row switches on
// `kind` with no union type.
import {useView, type ViewRef, view} from "react-fate";
import {Link} from "react-router";
import type {Contribution} from "../../../worker/features/fate/views";
import {toIso} from "../../fate/wire";
import {renderMarkdownInline} from "../../lib/markdown";

export const ContributionView = view<Contribution>()({
	kind: true,
	id: true,
	score: true,
	createdAt: true,
	bodyExcerpt: true,
	termSlug: true,
	termTitle: true,
	title: true,
	slug: true,
	postId: true,
	postTitle: true,
});

function formatDate(value: Date | string | null | undefined): string {
	const iso = toIso(value);
	if (!iso) return "";
	try {
		const d = new Date(iso);
		return d.toLocaleDateString("tr-TR", {day: "2-digit", month: "short", year: "numeric"});
	} catch {
		return iso;
	}
}

export interface ContributionRowProps {
	node: ViewRef<"Contribution">;
}

export function ContributionRow({node}: ContributionRowProps) {
	const c = useView(ContributionView, node);

	if (c.kind === "definition") {
		return (
			<li className="kp-user-profile__row" data-testid="contribution-definition">
				<div className="kp-user-profile__row-head">
					<span className="kp-user-profile__kind kp-user-profile__kind--definition">tanım</span>
					<Link to={`/sozluk/${c.termSlug}`} className="kp-user-profile__row-title">
						{c.termTitle}
					</Link>
					<span className="kp-user-profile__row-score">{c.score} puan</span>
					<span className="kp-user-profile__row-date">{formatDate(c.createdAt)}</span>
				</div>
				<p className="kp-user-profile__row-body">{renderMarkdownInline(c.bodyExcerpt ?? "")}</p>
			</li>
		);
	}

	if (c.kind === "post") {
		return (
			<li className="kp-user-profile__row" data-testid="contribution-post">
				<div className="kp-user-profile__row-head">
					<span className="kp-user-profile__kind kp-user-profile__kind--post">başlık</span>
					<Link to={`/pano/${c.id}`} className="kp-user-profile__row-title">
						{c.title}
					</Link>
					<span className="kp-user-profile__row-score">{c.score} puan</span>
					<span className="kp-user-profile__row-date">{formatDate(c.createdAt)}</span>
				</div>
				{c.bodyExcerpt ? (
					<p className="kp-user-profile__row-body">{renderMarkdownInline(c.bodyExcerpt)}</p>
				) : null}
			</li>
		);
	}

	if (c.kind === "comment") {
		return (
			<li className="kp-user-profile__row" data-testid="contribution-comment">
				<div className="kp-user-profile__row-head">
					<span className="kp-user-profile__kind kp-user-profile__kind--comment">yorum</span>
					<Link to={`/pano/${c.postId}`} className="kp-user-profile__row-title">
						{c.postTitle}
					</Link>
					<span className="kp-user-profile__row-score">{c.score} puan</span>
					<span className="kp-user-profile__row-date">{formatDate(c.createdAt)}</span>
				</div>
				<p className="kp-user-profile__row-body">{renderMarkdownInline(c.bodyExcerpt ?? "")}</p>
			</li>
		);
	}

	return null;
}
