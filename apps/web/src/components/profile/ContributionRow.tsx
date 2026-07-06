// `Contribution` is a single discriminant view (ADR 0018): one node carries `kind`
// plus the nullable union of all three variants' fields, so this row switches on
// `kind` with no union type.
import {useView, type ViewRef, view} from "react-fate";
import {Link} from "react-router";
import type {Contribution} from "../../../worker/features/fate/views";
import {toIso} from "../../fate/wire";
import {formatAgoTR} from "../../lib/datetime";
import {renderMarkdownInline} from "../../lib/markdown";
import "./ContributionRow.css";

export const ContributionView = view<Contribution>()({
	kind: true,
	id: true,
	score: true,
	createdAt: true,
	// The per-item review-state flag (#1316): `true` for a still-sandboxed item, so
	// the owner's profile can badge it "incelemede" (#1291). A bare boolean — carries
	// no reviewer identity (one-way glass). Sent only to the author/moderator, so a
	// non-owner viewer never receives a sandboxed row in the first place.
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
	/**
	 * Render the "incelemede" badge on a still-sandboxed item (#1291). The caller
	 * gates this on the çaylak-status gate (flag + own profile + çaylak), so the
	 * badge only appears for the owner's own pending items. Default `false`.
	 */
	sandboxBadge?: boolean;
}

export function ContributionRow({node, sandboxBadge = false}: ContributionRowProps) {
	const c = useView(ContributionView, node);
	const badge =
		sandboxBadge && c.sandboxed ? (
			<span className="kp-user-profile__badge" data-testid="incelemede-badge">
				incelemede
			</span>
		) : null;

	if (c.kind === "definition") {
		return (
			<li className="kp-user-profile__row" data-testid="contribution-definition">
				<div className="kp-user-profile__row-head">
					<span className="kp-user-profile__kind kp-user-profile__kind--definition">tanım</span>
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
					<span className="kp-user-profile__kind kp-user-profile__kind--post">başlık</span>
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
					<span className="kp-user-profile__kind kp-user-profile__kind--comment">yorum</span>
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
