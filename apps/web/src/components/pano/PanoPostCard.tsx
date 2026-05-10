/**
 * Fragment-shaped card for the pano feed (task_2, phoenix-relay-idiom).
 *
 * Replaces the prop-shaped `PanoPost` from the MVP. The component declares
 * its own `PanoPostCardFragment on Post` and reads via `useFragment` — the
 * page just spreads `<PanoPostCard post={edge.node} />` (a fragment ref) and
 * is no longer responsible for shaping leaf data into props.
 *
 * Side affordances (rank, save/hide) are still controlled by the parent
 * because they're list-position state, not Post state.
 */
import {graphql, useFragment} from "react-relay";
import {Link} from "react-router";
import type {PanoPostCardFragment$key} from "../../__generated__/PanoPostCardFragment.graphql";
import {formatAgoTR} from "../../lib/datetime";
import {Tag, type TagKind} from "../ui/atoms";
import {PostVoteWidget} from "./PanoPost";
import "./PanoPost.css";

const PanoPostCardFragmentDef = graphql`
	fragment PanoPostCardFragment on Post {
		id
		title
		url
		host
		score
		myVote
		commentCount
		createdAt
		author
		authorId
		slug
		tags {
			kind
			label
		}
	}
`;

export function PanoPostCard({
	post,
	rank,
	onSave,
	onHide,
}: {
	post: PanoPostCardFragment$key;
	rank?: number;
	onSave?: (id: string) => void;
	onHide?: (id: string) => void;
}) {
	const data = useFragment(PanoPostCardFragmentDef, post);
	const href = `/pano/${data.slug ?? data.id}`;
	// Site label — host in parens for external links, "yazı" for self-posts.
	const siteLabel = data.host ?? (data.url ? null : "yazı");
	const agoLabel = formatAgoTR(data.createdAt);

	return (
		<article className="kp-pano-post">
			<span className="kp-pano-post__rank">
				{rank != null ? String(rank).padStart(2, "0") : ""}
			</span>
			<PostVoteWidget
				postId={data.id}
				score={data.score}
				myVote={data.myVote === 1 ? 1 : null}
			/>
			<div className="kp-pano-post__body">
				<div className="kp-pano-post__title-row">
					{data.tags.length ? (
						<span className="kp-pano-post__tags">
							{data.tags.map((t, i) => (
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
