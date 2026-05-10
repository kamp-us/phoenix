import * as React from 'react';
import { Tag, type TagKind } from '../ui/atoms';
import { Tooltip } from '../ui/Tooltip';
import './PanoPost.css';

/* Vote control — up/down arrows with count between. */
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
    <div className="kp-vote" aria-label="Oy">
      <button
        className="kp-vote__btn"
        data-active={myVote === 1 ? '' : undefined}
        aria-pressed={myVote === 1}
        aria-label="Yukarı oy"
        onClick={() => onVote?.(1)}
      >▲</button>
      <span className="kp-vote__count">{count}</span>
      <button
        className="kp-vote__btn"
        data-active={myVote === -1 ? '' : undefined}
        aria-pressed={myVote === -1}
        aria-label="Aşağı oy"
        onClick={() => onVote?.(-1)}
      >▼</button>
    </div>
  );
}

/* Site host pill (github.com on a post). */
export function SiteHostPill({ host, children }: { host: string; children?: React.ReactNode }) {
  return (
    <a className="kp-site" href={`/pano/site/${host}`}>
      {children ?? host}
    </a>
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
}: {
  post: PanoPostData;
  onVote?: (id: string, delta: -1 | 1) => void;
}) {
  const titleEl = (
    <a href={post.href}>{post.title}</a>
  );
  return (
    <article className="kp-pano-post">
      <div className="kp-pano-post__rank">
        {post.rank != null ? post.rank : ''}
      </div>
      <VoteControl
        count={post.score}
        myVote={post.myVote}
        onVote={onVote ? (d) => onVote(post.id, d) : undefined}
      />
      <div className="kp-pano-post__main">
        <div className="kp-pano-post__title-row">
          <h3 className="kp-pano-post__title">
            {post.url ? (
              <Tooltip content={post.url} side="top">{titleEl}</Tooltip>
            ) : titleEl}
          </h3>
          {post.tags?.map((t, i) => (
            <Tag key={i} kind={t.kind} href={t.href}>{t.label}</Tag>
          ))}
          {post.host ? <SiteHostPill host={post.host} /> : null}
        </div>
        <div className="kp-pano-post__meta">
          <a href={`/u/${post.author}`}>@{post.author}</a>
          <span>·</span>
          <span>{post.agoLabel}</span>
          <span>·</span>
          <a href={`${post.href}#comments`}>{post.commentCount} yorum</a>
        </div>
      </div>
    </article>
  );
}

export function PanoPostList({
  posts,
  onVote,
}: {
  posts: PanoPostData[];
  onVote?: (id: string, delta: -1 | 1) => void;
}) {
  return (
    <div className="kp-pano-list">
      {posts.map((p) => <PanoPost key={p.id} post={p} onVote={onVote} />)}
    </div>
  );
}
