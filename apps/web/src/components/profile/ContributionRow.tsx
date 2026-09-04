// `Contribution` is one discriminant view carrying every variant's fields as
// nullables, so this row switches on `kind` with no union type. See ADR 0018.
import {useView, type ViewRef, view} from "react-fate";
import {Link} from "react-router";
import type {Contribution} from "../../../worker/features/fate/views";
import {toIso} from "../../fate/wire";
import {plural, useLocale} from "../../i18n";
import {formatAgoTR} from "../../lib/datetime";
import {renderMarkdownInline} from "../../lib/markdown";
import {Badge} from "../ui/Badge";
import {SandboxMarker} from "../ui/SandboxMarker";
import "./ContributionRow.css";

export const ContributionView = view<Contribution>()({
	kind: true,
	id: true,
	score: true,
	createdAt: true,
	sandboxed: true,
	sandboxedInPlace: true,
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
	 * The viewer authored these rows. The feed is author-scoped, so ownership is a
	 * property of the profile being read, not of the individual row — which is why it
	 * cannot be derived here and has to be passed down.
	 */
	isOwn?: boolean;
	sandboxBadge?: boolean;
}

export function ContributionRow({node, isOwn = false, sandboxBadge = false}: ContributionRowProps) {
	const {t, locale} = useLocale();
	const c = useView(ContributionView, node);
	const score = t(
		plural(locale, c.score, {
			one: "profile.contribution.score.one",
			other: "profile.contribution.score.other",
		}),
		{count: c.score},
	);
	// `sandboxBadge` is the caller's çaylak-status gate on the OWNER badge (#1316); a
	// surface that withholds it passes `undefined` and lands on `none` for the owner.
	const badge = (
		<SandboxMarker
			isOwn={isOwn}
			sandboxed={sandboxBadge ? c.sandboxed : undefined}
			sandboxedInPlace={c.sandboxedInPlace}
		/>
	);

	if (c.kind === "definition") {
		return (
			<li className="kp-user-profile__row" data-testid="contribution-definition">
				<div className="kp-user-profile__row-head">
					<Badge
						variant="secondary"
						className="kp-user-profile__kind kp-user-profile__kind--definition"
					>
						{t("profile.contribution.kind.definition")}
					</Badge>
					{badge}
					<Link to={`/sozluk/${c.termSlug}`} className="kp-user-profile__row-title">
						{c.termTitle}
					</Link>
					<span className="kp-user-profile__row-score">{score}</span>
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
						{t("profile.contribution.kind.post")}
					</Badge>
					{badge}
					<Link to={`/pano/${c.id}`} className="kp-user-profile__row-title">
						{c.title}
					</Link>
					<span className="kp-user-profile__row-score">{score}</span>
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
						{t("profile.contribution.kind.comment")}
					</Badge>
					{badge}
					<Link to={`/pano/${c.postId}`} className="kp-user-profile__row-title">
						{c.postTitle}
					</Link>
					<span className="kp-user-profile__row-score">{score}</span>
					<span className="kp-user-profile__row-date">{formatAgoTR(toIso(c.createdAt))}</span>
				</div>
				<p className="kp-user-profile__row-body">{renderMarkdownInline(c.bodyExcerpt ?? "")}</p>
			</li>
		);
	}

	return null;
}
