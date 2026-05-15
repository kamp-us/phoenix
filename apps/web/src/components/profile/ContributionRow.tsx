/**
 * Fragment-shaped contribution row (task_6, phoenix-relay-idiom).
 *
 * `ProfileContribution` is a GraphQL union
 * (`DefinitionContribution | PostContribution | CommentContribution`).
 * Unions don't compose with a single fragment cleanly, so the row component
 * does an inline-fragment switch on `__typename` and spreads one of three
 * sub-fragments — `DefinitionContributionFragment`,
 * `PostContributionFragment`, `CommentContributionFragment`. Each variant
 * declares the fields its renderer needs.
 *
 * The page (`UserProfilePage`) spreads the inline-fragment selections in its
 * pagination fragment (`UserProfileContributionsFragment`) and hands the row
 * a fragment ref per edge node.
 */
import {graphql, useFragment} from "react-relay";
import {Link} from "react-router";
import type {ContributionRow_comment$key} from "../../__generated__/ContributionRow_comment.graphql";
import type {ContributionRow_definition$key} from "../../__generated__/ContributionRow_definition.graphql";
import type {ContributionRow_node$key} from "../../__generated__/ContributionRow_node.graphql";
import type {ContributionRow_post$key} from "../../__generated__/ContributionRow_post.graphql";

const ContributionRowNodeFragmentDef = graphql`
	fragment ContributionRow_node on ProfileContribution {
		__typename
		... on DefinitionContribution {
			...ContributionRow_definition
		}
		... on PostContribution {
			...ContributionRow_post
		}
		... on CommentContribution {
			...ContributionRow_comment
		}
	}
`;

const ContributionRowDefinitionFragmentDef = graphql`
	fragment ContributionRow_definition on DefinitionContribution {
		id
		score
		createdAt
		bodyExcerpt
		termSlug
		termTitle
	}
`;

const ContributionRowPostFragmentDef = graphql`
	fragment ContributionRow_post on PostContribution {
		id
		score
		createdAt
		title
		slug
		# Aliased because PostContribution.bodyExcerpt is nullable (String)
		# whereas Definition/CommentContribution expose it as String! — Relay
		# refuses to merge selections of differing nullability under one name.
		postBodyExcerpt: bodyExcerpt
	}
`;

const ContributionRowCommentFragmentDef = graphql`
	fragment ContributionRow_comment on CommentContribution {
		id
		score
		createdAt
		bodyExcerpt
		postId
		postTitle
	}
`;

function formatDate(iso: string): string {
	try {
		const d = new Date(iso);
		return d.toLocaleDateString("tr-TR", {day: "2-digit", month: "short", year: "numeric"});
	} catch {
		return iso;
	}
}

export interface ContributionRowProps {
	node: ContributionRow_node$key;
}

export function ContributionRow({node}: ContributionRowProps) {
	const data = useFragment(ContributionRowNodeFragmentDef, node);

	if (data.__typename === "DefinitionContribution") {
		return <DefinitionRow node={data} />;
	}
	if (data.__typename === "PostContribution") {
		return <PostRow node={data} />;
	}
	if (data.__typename === "CommentContribution") {
		return <CommentRow node={data} />;
	}
	return null;
}

function DefinitionRow({node}: {node: ContributionRow_definition$key}) {
	const def = useFragment(ContributionRowDefinitionFragmentDef, node);
	return (
		<li className="kp-user-profile__row" data-testid="contribution-definition">
			<div className="kp-user-profile__row-head">
				<span className="kp-user-profile__kind kp-user-profile__kind--definition">tanım</span>
				<Link to={`/sozluk/${def.termSlug}`} className="kp-user-profile__row-title">
					{def.termTitle}
				</Link>
				<span className="kp-user-profile__row-score">{def.score} puan</span>
				<span className="kp-user-profile__row-date">{formatDate(def.createdAt)}</span>
			</div>
			<p className="kp-user-profile__row-body">{def.bodyExcerpt}</p>
		</li>
	);
}

function PostRow({node}: {node: ContributionRow_post$key}) {
	const post = useFragment(ContributionRowPostFragmentDef, node);
	return (
		<li className="kp-user-profile__row" data-testid="contribution-post">
			<div className="kp-user-profile__row-head">
				<span className="kp-user-profile__kind kp-user-profile__kind--post">başlık</span>
				<Link to={`/pano/${post.id}`} className="kp-user-profile__row-title">
					{post.title}
				</Link>
				<span className="kp-user-profile__row-score">{post.score} puan</span>
				<span className="kp-user-profile__row-date">{formatDate(post.createdAt)}</span>
			</div>
			{post.postBodyExcerpt ? (
				<p className="kp-user-profile__row-body">{post.postBodyExcerpt}</p>
			) : null}
		</li>
	);
}

function CommentRow({node}: {node: ContributionRow_comment$key}) {
	const comment = useFragment(ContributionRowCommentFragmentDef, node);
	return (
		<li className="kp-user-profile__row" data-testid="contribution-comment">
			<div className="kp-user-profile__row-head">
				<span className="kp-user-profile__kind kp-user-profile__kind--comment">yorum</span>
				<Link to={`/pano/${comment.postId}`} className="kp-user-profile__row-title">
					{comment.postTitle}
				</Link>
				<span className="kp-user-profile__row-score">{comment.score} puan</span>
				<span className="kp-user-profile__row-date">{formatDate(comment.createdAt)}</span>
			</div>
			<p className="kp-user-profile__row-body">{comment.bodyExcerpt}</p>
		</li>
	);
}
