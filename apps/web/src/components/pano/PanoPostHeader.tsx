/**
 * Fragment-shaped post-detail header (task_3, phoenix-relay-idiom).
 *
 * Reads its data via `useFragment(PanoPostHeaderFragment)` instead of taking
 * shaped props. The page (`PanoPostDetail`) spreads this fragment into the
 * top-level `PostQuery` and hands the post fragment ref down — the header
 * declares what it needs.
 *
 * Edit / delete affordances are gated by `isAuthor`, which the page derives
 * from the session and passes in (the session lookup belongs to the page,
 * not the header).
 */
import {graphql, useFragment} from "react-relay";
import type {PanoPostHeaderFragment$key} from "../../__generated__/PanoPostHeaderFragment.graphql";
import {formatAgoTR} from "../../lib/datetime";
import {renderMarkdownInline} from "../../lib/markdown";
import {Tag, type TagKind} from "../ui/atoms";
import {EditedIndicator} from "../ui/EditedIndicator";
import {PostVoteWidget} from "./PanoPost";

const PanoPostHeaderFragmentDef = graphql`
	fragment PanoPostHeaderFragment on Post {
		id
		slug
		title
		url
		host
		body
		author
		authorId
		score
		myVote
		commentCount
		createdAt
		updatedAt
		tags {
			kind
			label
		}
	}
`;

export interface PanoPostHeaderProps {
	post: PanoPostHeaderFragment$key;
	isAuthor: boolean;
	onEdit?: () => void;
	onDelete?: () => void;
}

export function PanoPostHeader(props: PanoPostHeaderProps) {
	const post = useFragment(PanoPostHeaderFragmentDef, props.post);
	return (
		<div>
			<h1 className="kp-pano-postpage__title">{post.title}</h1>
			{post.url ? (
				<a
					className="kp-pano-postpage__url"
					href={post.url}
					target="_blank"
					rel="noreferrer noopener"
				>
					{post.host ?? post.url} ↗
				</a>
			) : null}
			<div className="kp-pano-postpage__meta">
				{post.tags.map((t, i) => (
					<Tag key={i} kind={t.kind as TagKind}>
						{t.label}
					</Tag>
				))}
				<span className="author">@{post.author}</span>
				<span>·</span>
				<span>{formatAgoTR(post.createdAt)}</span>
				<EditedIndicator createdAt={post.createdAt} updatedAt={post.updatedAt} />
				<span>·</span>
				<span>{post.commentCount} yorum</span>
				<span>·</span>
				<button type="button">paylaş</button>
				<button type="button">kaydet</button>
				<button type="button">bildir</button>
				{props.isAuthor ? (
					<>
						<button type="button" data-testid="post-edit" onClick={props.onEdit}>
							düzenle
						</button>
						<button type="button" data-testid="post-delete" onClick={props.onDelete}>
							sil
						</button>
					</>
				) : null}
			</div>
			{post.body ? (
				<div className="kp-pano-postpage__body">
					{post.body.split(/\n{2,}/).map((para, i) => (
						<p key={i}>{renderMarkdownInline(para)}</p>
					))}
				</div>
			) : null}
		</div>
	);
}

/** Convenience accessor — pages need the score/myVote/id for the vote widget. */
export function PanoPostHeaderVote({post}: {post: PanoPostHeaderFragment$key}) {
	const data = useFragment(PanoPostHeaderFragmentDef, post);
	return <PostVoteWidget postId={data.id} score={data.score} myVote={data.myVote ?? null} />;
}
