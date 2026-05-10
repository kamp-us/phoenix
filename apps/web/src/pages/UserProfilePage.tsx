import * as React from "react";
import {graphql, useLazyLoadQuery} from "react-relay";
import {Link, useParams} from "react-router";
import type {UserProfilePageQuery} from "../__generated__/UserProfilePageQuery.graphql";
import {QueryBoundary} from "../relay/QueryBoundary";
import {NotFoundPage} from "./NotFoundPage";
import "./UserProfilePage.css";

const ProfileQuery = graphql`
  query UserProfilePageQuery($username: String!, $first: Int!, $after: String) {
    profile(username: $username) {
      user {
        id
        username
        name
        image
      }
      totalKarma
      definitionCount
      postCount
      commentCount
      contributions(first: $first, after: $after) {
        edges {
          cursor
          node {
            __typename
            ... on DefinitionContribution {
              id
              score
              createdAt
              bodyExcerpt
              termSlug
              termTitle
            }
            ... on PostContribution {
              id
              score
              createdAt
              title
              slug
              postBodyExcerpt: bodyExcerpt
            }
            ... on CommentContribution {
              id
              score
              createdAt
              bodyExcerpt
              postId
              postTitle
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

export function UserProfilePage() {
	const {username} = useParams<{username: string}>();
	const safeUsername = username ?? "";

	return (
		<QueryBoundary
			loading={
				<div className="kp-user-profile" data-testid="user-profile-loading">
					<div className="kp-user-profile__inner">yükleniyor…</div>
				</div>
			}
			error={(err) => (
				<div className="kp-user-profile">
					<div className="kp-user-profile__inner">
						<p style={{color: "var(--danger)"}}>profil yüklenemedi: {err.message}</p>
					</div>
				</div>
			)}
		>
			<UserProfileContent username={safeUsername} />
		</QueryBoundary>
	);
}

function initialsOf(name: string) {
	return name
		.split(/\s+|_|-/)
		.filter(Boolean)
		.slice(0, 2)
		.map((p) => p[0]?.toUpperCase() ?? "")
		.join("");
}

function formatDate(iso: string): string {
	try {
		const d = new Date(iso);
		return d.toLocaleDateString("tr-TR", {day: "2-digit", month: "short", year: "numeric"});
	} catch {
		return iso;
	}
}

function UserProfileContent({username}: {username: string}) {
	const [pageSize] = React.useState(20);
	const data = useLazyLoadQuery<UserProfilePageQuery>(ProfileQuery, {
		username,
		first: pageSize,
		after: null,
	});

	if (!data.profile) {
		return (
			<NotFoundPage
				title="kullanıcı bulunamadı"
				message={`@${username} burada yok. başka bir şeye bakmak ister misin?`}
			/>
		);
	}

	const p = data.profile;
	const displayName = p.user.name ?? p.user.username ?? "kullanıcı";
	const handle = p.user.username ?? username;
	const edges = p.contributions.edges;
	const hasMore = p.contributions.pageInfo.hasNextPage;

	return (
		<div className="kp-user-profile" data-testid="user-profile-page">
			<div className="kp-user-profile__inner">
				<header className="kp-user-profile__head">
					<div className="kp-user-profile__avatar" aria-hidden>
						{p.user.image ? (
							<img src={p.user.image} alt="" />
						) : (
							<span>{initialsOf(displayName)}</span>
						)}
					</div>
					<div className="kp-user-profile__id">
						<div className="kp-user-profile__name" data-testid="user-profile-display-name">
							{displayName}
						</div>
						<div className="kp-user-profile__handle" data-testid="user-profile-handle">
							@{handle}
						</div>
					</div>
					<div className="kp-user-profile__stats" data-testid="user-profile-stats">
						<div className="kp-user-profile__stat" data-testid="stat-definitions">
							<div className="n">{p.definitionCount}</div>
							<div className="l">tanım</div>
						</div>
						<div className="kp-user-profile__stat" data-testid="stat-posts">
							<div className="n">{p.postCount}</div>
							<div className="l">başlık</div>
						</div>
						<div className="kp-user-profile__stat" data-testid="stat-comments">
							<div className="n">{p.commentCount}</div>
							<div className="l">yorum</div>
						</div>
						<div className="kp-user-profile__stat" data-testid="stat-karma">
							<div className="n">{p.totalKarma}</div>
							<div className="l">karma</div>
						</div>
					</div>
				</header>

				<section className="kp-user-profile__feed" data-testid="user-profile-feed">
					<h3>katkılar</h3>
					{edges.length === 0 ? (
						<p className="kp-user-profile__empty">henüz katkı yok.</p>
					) : (
						<ul className="kp-user-profile__list">
							{edges.map((edge) => (
								<ContributionRow key={edge.cursor} node={edge.node} />
							))}
						</ul>
					)}
					{hasMore ? (
						<p className="kp-user-profile__more" data-testid="user-profile-has-more">
							daha fazla katkı var
						</p>
					) : null}
				</section>
			</div>
		</div>
	);
}

type Edge = NonNullable<
	UserProfilePageQuery["response"]["profile"]
>["contributions"]["edges"][number];
type Node = Edge["node"];

function ContributionRow({node}: {node: Node}) {
	if (node.__typename === "DefinitionContribution") {
		return (
			<li className="kp-user-profile__row" data-testid="contribution-definition">
				<div className="kp-user-profile__row-head">
					<span className="kp-user-profile__kind kp-user-profile__kind--definition">tanım</span>
					<Link to={`/sozluk/${node.termSlug}`} className="kp-user-profile__row-title">
						{node.termTitle}
					</Link>
					<span className="kp-user-profile__row-score">{node.score} puan</span>
					<span className="kp-user-profile__row-date">{formatDate(node.createdAt)}</span>
				</div>
				<p className="kp-user-profile__row-body">{node.bodyExcerpt}</p>
			</li>
		);
	}
	if (node.__typename === "PostContribution") {
		return (
			<li className="kp-user-profile__row" data-testid="contribution-post">
				<div className="kp-user-profile__row-head">
					<span className="kp-user-profile__kind kp-user-profile__kind--post">başlık</span>
					<Link to={`/pano/${node.id}`} className="kp-user-profile__row-title">
						{node.title}
					</Link>
					<span className="kp-user-profile__row-score">{node.score} puan</span>
					<span className="kp-user-profile__row-date">{formatDate(node.createdAt)}</span>
				</div>
				{node.postBodyExcerpt ? (
					<p className="kp-user-profile__row-body">{node.postBodyExcerpt}</p>
				) : null}
			</li>
		);
	}
	if (node.__typename === "CommentContribution") {
		return (
			<li className="kp-user-profile__row" data-testid="contribution-comment">
				<div className="kp-user-profile__row-head">
					<span className="kp-user-profile__kind kp-user-profile__kind--comment">yorum</span>
					<Link to={`/pano/${node.postId}`} className="kp-user-profile__row-title">
						{node.postTitle}
					</Link>
					<span className="kp-user-profile__row-score">{node.score} puan</span>
					<span className="kp-user-profile__row-date">{formatDate(node.createdAt)}</span>
				</div>
				<p className="kp-user-profile__row-body">{node.bodyExcerpt}</p>
			</li>
		);
	}
	return null;
}
