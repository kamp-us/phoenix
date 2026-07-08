/**
 * fate-shaped card for the pano feed. Reads its slice via
 * `useLiveView(PanoPostCardView, ref)`. Rank and hide stay with the parent
 * because they're list-position state, not Post state; save reads `isSaved` off
 * the post itself, so the card owns the bookmark toggle (`PostSaveButton`).
 */
import {useLiveView, type ViewRef, view} from "react-fate";
import {Link} from "react-router";
import type {Post} from "../../../worker/features/fate/views";
import {useSession} from "../../auth/client";
import {toIso} from "../../fate/wire";
import {formatAgoTR} from "../../lib/datetime";
import {tagClass} from "../../lib/panoTags";
import {
	type OverlayState,
	PENDING_OVERLAY,
	resolveOverlay,
	type ViewerOverlay,
} from "../../pages/panoFeedOverlay";
import {actorLabel} from "../moderation/actor-identity";
import {Tag, type TagKind} from "../ui/atoms";
import {MetaRow} from "../ui/MetaRow";
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
	authorUsername: true,
	authorDisplayName: true,
	slug: true,
	tags: true,
});

/**
 * The identity-guarded viewer scalars for one row's controls (leg B compose path). While
 * the session is still resolving the overlay is `pending` → neutral (base painted, overlay
 * not yet landed); once resolved it is a single-row batch tagged with the current identity,
 * which `resolveOverlay` re-checks so a stale/foreign overlay reads neutral. See
 * `panoFeedOverlay`.
 */
function composedScalars(
	sessionPending: boolean,
	viewerId: string | null,
	row: {id: string; myVote?: boolean | null; isSaved?: boolean | null},
): ViewerOverlay {
	const state: OverlayState = sessionPending
		? PENDING_OVERLAY
		: {
				status: "landed",
				identity: viewerId,
				byId: new Map([[row.id, {myVote: row.myVote ?? null, isSaved: row.isSaved ?? null}]]),
			};
	return resolveOverlay(state, viewerId, row.id);
}

export function PanoPostCard({
	post,
	rank,
	onHide,
	compose = false,
}: {
	post: ViewRef<"Post">;
	rank?: number;
	onHide?: (id: string) => void;
	/**
	 * Base + overlay composition (#2323, leg B, dark behind `pano-base-feed`). When set,
	 * the viewer scalars (`myVote`/`isSaved`) render through the identity guard
	 * (`panoFeedOverlay`): neutral while the session is still resolving (base painted,
	 * overlay pending), then the viewer's own scalars once the session lands under a
	 * matching identity — so a stale/foreign overlay (e.g. a snapshot's prior-identity
	 * scalars) never paints. Off (the default / flag-off) ⇒ scalars read straight off the
	 * post, byte-identical to today.
	 */
	compose?: boolean;
}) {
	const data = useLiveView(PanoPostCardView, post);
	const session = useSession();
	const isOwn = !!session.data?.user && session.data.user.id === data.authorId;
	// The viewer scalars fed to the vote/save controls: flag-off reads them straight off the
	// post (byte-identical to today); compose routes them through the identity guard below.
	const {myVote, isSaved} = compose
		? composedScalars(session.isPending, session.data?.user?.id ?? null, data)
		: {myVote: data.myVote ?? null, isSaved: data.isSaved ?? null};
	const href = `/pano/${data.slug ?? data.id}`;
	const siteLabel = data.host ?? (data.url ? null : "yazı");
	const agoLabel = formatAgoTR(toIso(data.createdAt));
	const tags = data.tags ?? [];

	return (
		<article className="kp-pano-post">
			<span className="kp-pano-post__rank">
				{rank != null ? String(rank).padStart(2, "0") : ""}
			</span>
			<PostVoteWidget postId={data.id} score={data.score} myVote={myVote} own={isOwn} />
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
					<a className="kp-pano-post__title kp-prose" href={data.url ?? href} title={data.title}>
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
				<MetaRow className="kp-pano-post__meta">
					{/* Live author identity via `actorLabel` (#2139): current displayName → @username,
					    falling back to the write-time `author` snapshot for an unstamped/legacy row. */}
					<span className="author">
						{actorLabel(data.authorDisplayName ?? null, data.authorUsername ?? null, data.author)}
					</span>
					<MetaRow.Dot />
					<span>{agoLabel}</span>
					<MetaRow.Dot />
					<a href={`${href}#comments`}>{data.commentCount} yorum</a>
					<MetaRow.Dot />
					<PostSaveButton postId={data.id} isSaved={isSaved} />
					{onHide ? (
						<>
							<MetaRow.Dot />
							<button type="button" onClick={() => onHide(data.id)}>
								gizle
							</button>
						</>
					) : null}
				</MetaRow>
			</div>
		</article>
	);
}
