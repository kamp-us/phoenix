import { Tag, type TagKind } from '../ui/atoms';
import './PanoPost.css';

/* Vote control — single triangle upvote with count below (lobsters-shape). */
export function VoteControl({
  count,
  myVote = 0,
  onVote,
}: {
  count: number;
  myVote?: -1 | 0 | 1;
  onVote?: (delta: -1 | 1) => void;
}) {
  return (
    <div className="kp-pano-post__vote" aria-label="Oy">
      <button
        type="button"
        className="kp-pano-post__vote-btn"
        aria-pressed={myVote === 1}
        aria-label="Yukarı oy"
        onClick={() => onVote?.(1)}
      >
        <span className="triangle" />
      </button>
      <span className="kp-pano-post__vote-count">{count}</span>
    </div>
  );
}

export type PanoPostData = {
  id: string;
  rank?: number;
  title: string;
  href: string;
  url?: string;
  host?: string;
  tags?: { kind: TagKind; label: string; href?: string }[];
  author: string;
  agoLabel: string;
  commentCount: number;
  score: number;
  myVote?: -1 | 0 | 1;
};

export function PanoPost({
  post,
  onVote,
  onSave,
  onHide,
}: {
  post: PanoPostData;
  onVote?: (id: string, delta: -1 | 1) => void;
  onSave?: (id: string) => void;
  onHide?: (id: string) => void;
}) {
  /* Site label — host in parens for external links, "yazı" for self-posts. */
  const siteLabel = post.host ?? (post.url ? null : 'yazı');

  return (
    <article className="kp-pano-post">
      <span className="kp-pano-post__rank">
        {post.rank != null ? String(post.rank).padStart(2, '0') : ''}
      </span>
      <VoteControl
        count={post.score}
        myVote={post.myVote}
        onVote={onVote ? (d) => onVote(post.id, d) : undefined}
      />
      <div className="kp-pano-post__body">
        <div className="kp-pano-post__title-row">
          {post.tags?.length ? (
            <span className="kp-pano-post__tags">
              {post.tags.map((t, i) => (
                <Tag key={i} kind={t.kind} href={t.href}>{t.label}</Tag>
              ))}
            </span>
          ) : null}
          <a className="kp-pano-post__title" href={post.url ?? post.href}>
            {post.title}
          </a>
          {siteLabel ? <span className="kp-pano-post__site">{siteLabel}</span> : null}
        </div>
        <div className="kp-pano-post__meta">
          <span className="author">@{post.author}</span>
          <span className="dot">·</span>
          <span>{post.agoLabel}</span>
          <span className="dot">·</span>
          <a href={`${post.href}#comments`}>{post.commentCount} yorum</a>
          {onSave ? (
            <>
              <span className="dot">·</span>
              <button type="button" onClick={() => onSave(post.id)}>kaydet</button>
            </>
          ) : null}
          {onHide ? (
            <>
              <span className="dot">·</span>
              <button type="button" onClick={() => onHide(post.id)}>gizle</button>
            </>
          ) : null}
        </div>
      </div>
    </article>
  );
}

export function PanoPostList({
  posts,
  onVote,
  onSave,
  onHide,
}: {
  posts: PanoPostData[];
  onVote?: (id: string, delta: -1 | 1) => void;
  onSave?: (id: string) => void;
  onHide?: (id: string) => void;
}) {
  return (
    <div className="kp-pano-list">
      {posts.map((p) => (
        <PanoPost key={p.id} post={p} onVote={onVote} onSave={onSave} onHide={onHide} />
      ))}
    </div>
  );
}
