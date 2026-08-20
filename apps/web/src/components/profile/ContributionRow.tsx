// `Contribution` is one discriminant view carrying every variant's fields as
// nullables, so this row switches on `kind` with no union type. See ADR 0018.
import {useView, type ViewRef, view} from "react-fate";
import {Link} from "react-router";
import type {Contribution} from "../../../worker/features/fate/views";
import {toIso} from "../../fate/wire";
import {formatAgoTR} from "../../lib/datetime";
import {renderMarkdownInline} from "../../lib/markdown";
import {Badge} from "../ui/Badge";
import {ReviewBadge} from "../ui/ReviewBadge";
import "./ContributionRow.css";

export const ContributionView = view<Contribution>()({
	kind: true,
	id: true,
	score: true,
	createdAt: true,
	// A bare boolean carrying no reviewer identity (one-way glass), and sent only to
	// the author/moderator — a non-owner never receives a sandboxed row at all.
	sandboxed: true,
	bodyExcerpt: true,
	termSlug: true,
	termTitle: true,
	title: true,
	slug: true,
	postId: true,
	postTitle: true,
});

export interface ContributionRowProps {
	node: ViewRef<"Contribution">;
	sandboxBadge?: boolean;
}

export function ContributionRow({node, sandboxBadge = false}: ContributionRowProps) {
	const c = useView(ContributionView, node);
	const badge = sandboxBadge && c.sandboxed ? <ReviewBadge /> : null;

	if (c.kind === "definition") {
		return (
			<li className="kp-user-profile__row" data-testid="contribution-definition">
				<div className="kp-user-profile__row-head">
					<Badge
						variant="secondary"
						className="kp-user-profile__kind kp-user-profile__kind--definition"
					>
						tanım
					</Badge>
					{badge}
					<Link to={`/sozluk/${c.termSlug}`} className="kp-user-profile__row-title">
						{c.termTitle}
					</Link>
					<span className="kp-user-profile__row-score">{c.score} oy</span>
					<span className="kp-user-profile__row-date">{formatAgoTR(toIso(c.createdAt))}</span>
				</div>
				<p className="kp-user-profile__row-body">{renderMarkdownInline(c.bodyExcerpt ?? "")}</p>
			</li>
		);
	}

	if (c.kind === "post") {
		return (
			<li className="kp-user-profile__row" data-testid="contribution-post">
				<div className="kp-user-profile__row-head">
					<Badge variant="secondary" className="kp-user-profile__kind kp-user-profile__kind--post">
						başlık
					</Badge>
					{badge}
					<Link to={`/pano/${c.id}`} className="kp-user-profile__row-title">
						{c.title}
					</Link>
					<span className="kp-user-profile__row-score">{c.score} oy</span>
					<span className="kp-user-profile__row-date">{formatAgoTR(toIso(c.createdAt))}</span>
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
					<Badge
						variant="secondary"
						className="kp-user-profile__kind kp-user-profile__kind--comment"
					>
						yorum
					</Badge>
					{badge}
					<Link to={`/pano/${c.postId}`} className="kp-user-profile__row-title">
						{c.postTitle}
					</Link>
					<span className="kp-user-profile__row-score">{c.score} oy</span>
					<span className="kp-user-profile__row-date">{formatAgoTR(toIso(c.createdAt))}</span>
				</div>
				<p className="kp-user-profile__row-body">{renderMarkdownInline(c.bodyExcerpt ?? "")}</p>
			</li>
		);
	}

	return null;
}
