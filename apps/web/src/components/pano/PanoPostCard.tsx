/**
 * fate-shaped card for the pano feed. Reads its slice via
 * `useLiveView(PanoPostCardView, ref)`. Rank and hide stay with the parent
 * because they're list-position state, not Post state; save reads `isSaved` off
 * the post itself, so the card owns the bookmark toggle (`PostSaveButton`).
 */
import {useLiveView, type ViewRef, view} from "react-fate";
import {Link} from "react-router";
import type {Post} from "../../../worker/features/fate/views";
import {toIso} from "../../fate/wire";
import {formatAgoTR} from "../../lib/datetime";
import {tagClass} from "../../lib/panoTags";
import {Tag, type TagKind} from "../ui/atoms";
import {PostSaveButton, PostVoteWidget} from "./PanoPost";
import "./PanoPost.css";

export const PanoPostCardView = view<Post>()({
	id: true,
	title: true,
	url: true,
	host: true,
	score: true,
	myVote: true,
	isSaved: true,
	commentCount: true,
	createdAt: true,
	author: true,
	authorId: true,
	slug: true,
	tags: true,
});

export function PanoPostCard({
	post,
	rank,
	onHide,
}: {
	post: ViewRef<"Post">;
	rank?: number;
	onHide?: (id: string) => void;
}) {
	const data = useLiveView(PanoPostCardView, post);
	const href = `/pano/${data.slug ?? data.id}`;
	const siteLabel = data.host ?? (data.url ? null : "yazı");
	const agoLabel = formatAgoTR(toIso(data.createdAt));
	const tags = data.tags ?? [];

	return (
		<article className="kp-pano-post">
			<span className="kp-pano-post__rank">
				{rank != null ? String(rank).padStart(2, "0") : ""}
			</span>
			<PostVoteWidget postId={data.id} score={data.score} myVote={data.myVote === 1 ? 1 : null} />
			<div className="kp-pano-post__body">
				<div className="kp-pano-post__title-row">
					{tags.length ? (
						<span className="kp-pano-post__tags">
							{tags.map((t, i) => (
								<Tag key={i} kind={tagClass(t.kind) as TagKind}>
									{t.label}
								</Tag>
							))}
						</span>
					) : null}
					<a className="kp-pano-post__title kp-prose" href={data.url ?? href}>
						{data.title}
					</a>
					{data.host ? (
						<Link className="kp-pano-post__site" to={`/pano/site/${data.host}`}>
							{data.host}
						</Link>
					) : siteLabel ? (
						<span className="kp-pano-post__site">{siteLabel}</span>
					) : null}
				</div>
				<div className="kp-pano-post__meta">
					<span className="author">@{data.author}</span>
					<span className="dot">·</span>
					<span>{agoLabel}</span>
					<span className="dot">·</span>
					<a href={`${href}#comments`}>{data.commentCount} yorum</a>
					<span className="dot">·</span>
					<PostSaveButton postId={data.id} isSaved={data.isSaved ?? null} />
					{onHide ? (
						<>
							<span className="dot">·</span>
							<button type="button" onClick={() => onHide(data.id)}>
								gizle
							</button>
						</>
					) : null}
				</div>
			</div>
		</article>
	);
}
