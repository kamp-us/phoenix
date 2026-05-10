import * as React from 'react';
import { graphql, useMutation } from 'react-relay';
import { Link } from 'react-router';
import type { PanoPostVoteMutation } from '../../__generated__/PanoPostVoteMutation.graphql';
import { useSession } from '../../auth/client';
import { Tag, type TagKind } from '../ui/atoms';
import './PanoPost.css';

/* Vote control — single triangle upvote with count below (lobsters-shape).
   Stays presentational; the parent owns the mutation + auth gate. */
export function VoteControl({
  count,
  pressed = false,
  onToggle,
}: {
  count: number;
  pressed?: boolean;
  onToggle?: () => void;
}) {
  return (
    <div className="kp-pano-post__vote" aria-label="Oy">
      <button
        type="button"
        className="kp-pano-post__vote-btn"
        aria-pressed={pressed}
        aria-label="Yukarı oy"
        onClick={() => onToggle?.()}
      >
        <span className="triangle" />
      </button>
      <span className="kp-pano-post__vote-count">{count}</span>
    </div>
  );
}

const PostVoteMutation = graphql`
  mutation PanoPostVoteMutation($input: VoteInput!) {
    voteOnPost(input: $input) {
      score
    }
  }
`;

/**
 * Local-only vote state. The lobsters-shape only has an upvote arm, so the
 * triangle toggles between 1 and 0. The displayed score comes from
 * `post.score` plus our last optimistic delta — the Relay mutation also
 * writes the authoritative score back into the store via the `voteOnPost`
 * field's response (which patches the standalone VoteResult node), but
 * `post.score` itself isn't updated server-side without a refetch. So we
 * track a local `delta` and rely on the optimisticUpdater to keep the UI
 * coherent until the page is reloaded.
 */
export function PostVoteWidget({postId, baseScore}: {postId: string; baseScore: number}) {
  const session = useSession();
  const [commit, isInFlight] = useMutation<PanoPostVoteMutation>(PostVoteMutation);
  const [pressed, setPressed] = React.useState(false);
  const [delta, setDelta] = React.useState(0);

  const onToggle = () => {
    if (!session.data?.user) {
      console.warn('[pano] vote requires sign-in');
      return;
    }
    if (isInFlight) return;
    const nextPressed = !pressed;
    const nextValue: 0 | 1 = nextPressed ? 1 : 0;
    const nextDelta = nextValue - (pressed ? 1 : 0);
    setPressed(nextPressed);
    setDelta((d) => d + nextDelta);
    commit({
      variables: {input: {targetId: postId, value: nextValue}},
      onError: () => {
        /* Roll back the optimistic delta + pressed state. */
        setPressed(pressed);
        setDelta((d) => d - nextDelta);
      },
    });
  };

  return (
    <VoteControl count={baseScore + delta} pressed={pressed} onToggle={onToggle} />
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
  onSave,
  onHide,
}: {
  post: PanoPostData;
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
      <PostVoteWidget postId={post.id} baseScore={post.score} />
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
          {post.host ? (
            <Link className="kp-pano-post__site" to={`/pano/site/${post.host}`}>
              {post.host}
            </Link>
          ) : siteLabel ? (
            <span className="kp-pano-post__site">{siteLabel}</span>
          ) : null}
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
  onSave,
  onHide,
}: {
  posts: PanoPostData[];
  onSave?: (id: string) => void;
  onHide?: (id: string) => void;
}) {
  return (
    <div className="kp-pano-list">
      {posts.map((p) => (
        <PanoPost key={p.id} post={p} onSave={onSave} onHide={onHide} />
      ))}
    </div>
  );
}
