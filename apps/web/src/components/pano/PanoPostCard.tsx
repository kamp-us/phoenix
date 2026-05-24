/**
 * fate-shaped card for the pano feed.
 *
 * Reads its data via `useView(PanoPostCardView, ref)` — the feed composes
 * `PanoPostCardView` into the `posts` connection and hands each node `ViewRef`
 * down. The card declares the fields it needs; fate masks the rest.
 *
 * IDs are raw per-type values on fate (`post_<ulid>`), so links and the vote
 * widget's testid use `data.id` directly (no `extractLocalId` global-id unwrap).
 *
 * Side affordances (rank, save/hide) are still controlled by the parent because
 * they're list-position state, not Post state.
 */
import {useLiveView, type ViewRef, view} from "react-fate";
import {Link} from "react-router";
import type {Post} from "../../../worker/fate/views";
import {formatAgoTR} from "../../lib/datetime";
import {Tag, type TagKind} from "../ui/atoms";
import {PostVoteWidget} from "./PanoPost";
import "./PanoPost.css";

/** The fields a feed card reads. Co-located with the component. */
export const PanoPostCardView = view<Post>()({
	id: true,
	title: true,
	url: true,
	host: true,
	score: true,
	myVote: true,
	commentCount: true,
	createdAt: true,
	author: true,
	authorId: true,
	slug: true,
	tags: true,
});

/** Wire dates arrive as strings though the entity type says `Date`. */
const toIso = (value: Date | string | null | undefined): string =>
	value == null ? "" : value instanceof Date ? value.toISOString() : String(value);

export function PanoPostCard({
	post,
	rank,
	onSave,
	onHide,
}: {
	post: ViewRef<"Post">;
	rank?: number;
	onSave?: (id: string) => void;
	onHide?: (id: string) => void;
}) {
	// Live: a `post.vote`/`retractVote` on another client publishes
	// `live.update("Post", id, {changed:["score"]})` with the re-resolved node
	// inline, so the feed card's score re-renders without a refetch.
	const data = useLiveView(PanoPostCardView, post);
	// Raw post id (or slug) — the /pano/:id route key.
	const href = `/pano/${data.slug ?? data.id}`;
	// Site label — host in parens for external links, "yazı" for self-posts.
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
								<Tag key={i} kind={t.kind as TagKind}>
									{t.label}
								</Tag>
							))}
						</span>
					) : null}
					<a className="kp-pano-post__title" href={data.url ?? href}>
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
					{onSave ? (
						<>
							<span className="dot">·</span>
							<button type="button" onClick={() => onSave(data.id)}>
								kaydet
							</button>
						</>
					) : null}
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
