/**
 * Contribution row — fate.
 *
 * The GraphQL `ProfileContribution` **union** became a single **discriminant**
 * data view (ADR 0018): `Contribution` carries a `kind`
 * (`"definition" | "post" | "comment"`) plus the union of all three variants'
 * fields (variant fields nullable, populated per `kind`). So the row reads one
 * `ContributionView` and switches on `kind` — the same switch the GraphQL
 * `__typename` drove, with no union/inline-fragment machinery.
 *
 * The page (`UserProfilePage`) selects `ContributionView` as the node of the
 * `contributions` connection; each edge node is a `ViewRef<"Contribution">`
 * handed here.
 */
import {useView, type ViewRef, view} from "react-fate";
import {Link} from "react-router";
import type {Contribution} from "../../../worker/fate/views";

/** The full discriminant selection — every field any `kind` branch reads. */
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

/** Wire dates arrive as strings though the entity type says `Date`. */
const toIso = (value: Date | string | null | undefined): string =>
	value == null ? "" : value instanceof Date ? value.toISOString() : String(value);

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
				<p className="kp-user-profile__row-body">{c.bodyExcerpt}</p>
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
				{c.bodyExcerpt ? <p className="kp-user-profile__row-body">{c.bodyExcerpt}</p> : null}
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
				<p className="kp-user-profile__row-body">{c.bodyExcerpt}</p>
			</li>
		);
	}

	return null;
}
