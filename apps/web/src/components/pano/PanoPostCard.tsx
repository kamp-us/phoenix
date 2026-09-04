/**
 * fate-shaped card for the pano feed. Rank and hide belong to the parent —
 * list-position state, not Post state.
 */
import {useLiveView, type ViewRef, view} from "react-fate";
import {Link} from "react-router";
import type {Post} from "../../../worker/features/fate/views";
import {useSession} from "../../auth/client";
import {toIso} from "../../fate/wire";
import {useLocale} from "../../i18n";
import {formatAgoTR} from "../../lib/datetime";
import {tagClass} from "../../lib/panoTags";
import {
	type OverlayState,
	PENDING_OVERLAY,
	resolveOverlay,
	type ViewerOverlay,
} from "../../pages/panoFeedOverlay";
import {actorLabel} from "../moderation/actor-identity";
import {MuteButton} from "../mute/MuteButton";
import {useMutedMembers} from "../mute/useMemberMute";
import {Tag, type TagKind} from "../ui/atoms";
import {Button} from "../ui/Button";
import {MetaRow} from "../ui/MetaRow";
import {SandboxMarker} from "../ui/SandboxMarker";
import {commentCountLabel} from "./commentCount";
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
	sandboxedInPlace: true,
	tags: true,
});

/** Identity-guarded viewer scalars — a stale or foreign overlay reads neutral. See `panoFeedOverlay`. */
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
	muteEnabled = false,
}: {
	post: ViewRef<"Post">;
	rank?: number;
	onHide?: (id: string) => void;
	/**
	 * Set on viewer-invariant base feed rows (#2323): viewer scalars go through the
	 * identity guard. Unset ⇒ read straight off the post, whose read already stamped
	 * the viewer.
	 */
	compose?: boolean;
	/** Threaded down from the feed, which reads the `member-mute` flag once (#3117). */
	muteEnabled?: boolean;
}) {
	const {locale, t} = useLocale();
	const data = useLiveView(PanoPostCardView, post);
	const session = useSession();
	const {isMuted} = useMutedMembers();
	const isOwn = !!session.data?.user && session.data.user.id === data.authorId;
	const authorLabel = actorLabel(
		data.authorDisplayName ?? null,
		data.authorUsername ?? null,
		data.author,
	);
	// Client-side echo of the mute; the server read-mask (#3113) is the source of truth.
	if (muteEnabled && data.authorId && isMuted(data.authorId)) return null;
	const {myVote, isSaved} = compose
		? composedScalars(session.isPending, session.data?.user?.id ?? null, data)
		: {myVote: data.myVote ?? null, isSaved: data.isSaved ?? null};
	const href = `/pano/${data.slug ?? data.id}`;
	const siteLabel = data.host ?? (data.url ? null : t("pano.post.text"));
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
					{/* Deliberate: the title routes to the post detail everywhere, never to the
					    external URL — that link-out lives on the domain label. Founder ruling, #2437. */}
					<Link className="kp-pano-post__title kp-prose" to={href} title={data.title}>
						{data.title}
					</Link>
					{data.url ? (
						<a
							className="kp-pano-post__site"
							href={data.url}
							target="_blank"
							rel="noreferrer noopener"
						>
							{data.host ?? data.url} ↗
						</a>
					) : siteLabel ? (
						<span className="kp-pano-post__site">{siteLabel}</span>
					) : null}
				</div>
				<MetaRow className="kp-pano-post__meta">
					{/* The reader-facing çaylak marker (#6427). The feed row has never selected the
					    owner-scoped `sandboxed` field, so an author still sees nothing on their own
					    row here — `SandboxMarker` lands on `none` for them, as it did before. */}
					<SandboxMarker isOwn={isOwn} sandboxedInPlace={data.sandboxedInPlace} />
					{/* Live author identity via `actorLabel` (#2139): current displayName → @username,
					    falling back to the write-time `author` snapshot for an unstamped/legacy row. */}
					<span className="author">{authorLabel}</span>
					<MetaRow.Dot />
					<span>{agoLabel}</span>
					<MetaRow.Dot />
					<a href={`${href}#comments`}>{commentCountLabel(t, locale, data.commentCount)}</a>
					<MetaRow.Dot />
					<PostSaveButton postId={data.id} isSaved={isSaved} />
					{muteEnabled && !isOwn && data.authorId ? (
						<>
							<MetaRow.Dot />
							<MuteButton
								memberId={data.authorId}
								memberLabel={authorLabel}
								testId={`member-mute-${data.authorId}`}
							/>
						</>
					) : null}
					{onHide ? (
						<>
							<MetaRow.Dot />
							<Button type="button" variant="link" size="sm" onClick={() => onHide(data.id)}>
								{t("pano.action.hide")}
							</Button>
						</>
					) : null}
				</MetaRow>
			</div>
		</article>
	);
}
