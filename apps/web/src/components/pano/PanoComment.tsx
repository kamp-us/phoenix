import * as React from 'react';
import { graphql, useMutation } from 'react-relay';
import { useNavigate } from 'react-router';
import type { PanoCommentRetractVoteMutation } from '../../__generated__/PanoCommentRetractVoteMutation.graphql';
import type { PanoCommentVoteMutation } from '../../__generated__/PanoCommentVoteMutation.graphql';
import { useSession } from '../../auth/client';
import { Menu } from '../ui/Menu';
import './PanoComment.css';

export type CommentData = {
  id: string;
  hash?: string;        /* "c_2814" */
  author: string;
  agoLabel: string;
  body: React.ReactNode;
  score: number;
  myVote?: number | null;
  isOwner?: boolean;
  isOp?: boolean;
  highlight?: boolean;  /* hash-targeted */
  /** Optional inline reply composer rendered right after the comment body,
   *  above any nested children. Owned by the page so it can wire to the
   *  `addComment` mutation + refetch. */
  replyComposer?: React.ReactNode;
  children?: CommentData[];
};

/**
 * Cast an upvote on a comment (task_11). Returns the updated `score` + `myVote`
 * so Relay merges into the store keyed by `id` — the vote button and any
 * other place that renders this comment node update authoritatively without
 * a refetch.
 */
const CommentVoteMutation = graphql`
  mutation PanoCommentVoteMutation($commentId: ID!) {
    voteOnComment(commentId: $commentId) {
      id
      score
      myVote
    }
  }
`;

/**
 * Retract a previously cast upvote (task_11). Symmetric to voteOnComment.
 */
const CommentRetractVoteMutation = graphql`
  mutation PanoCommentRetractVoteMutation($commentId: ID!) {
    retractCommentVote(commentId: $commentId) {
      id
      score
      myVote
    }
  }
`;

export function PanoComment({
  comment,
  depth = 0,
  onEdit,
  onDelete,
  onReply,
}: {
  comment: CommentData;
  depth?: number;
  onEdit?: (id: string) => void;
  onDelete?: (id: string) => void;
  onReply?: (id: string) => void;
}) {
  const session = useSession();
  const navigate = useNavigate();
  const [open, setOpen] = React.useState(true);
  const [voteCommit, voteInFlight] = useMutation<PanoCommentVoteMutation>(CommentVoteMutation);
  const [retractCommit, retractInFlight] =
    useMutation<PanoCommentRetractVoteMutation>(CommentRetractVoteMutation);

  const voted = (comment.myVote ?? 0) === 1;
  const score = comment.score;
  const inFlight = voteInFlight || retractInFlight;

  const cls = [
    'kp-comment',
    depth === 1 ? 'kp-comment--depth-1' : '',
    depth >= 2 ? 'kp-comment--depth-2' : '',
    comment.highlight ? 'kp-comment--highlighted' : '',
  ].filter(Boolean).join(' ');

  const onUpvote = () => {
    if (!session.data?.user) {
      navigate(`/auth?returnTo=${encodeURIComponent(window.location.pathname)}`);
      return;
    }
    if (inFlight) return;
    if (voted) {
      // Optimistic flip: -1 score, myVote → null.
      retractCommit({
        variables: {commentId: comment.id},
        optimisticResponse: {
          retractCommentVote: {
            id: comment.id,
            score: Math.max(0, score - 1),
            myVote: null,
          },
        },
        onError: (err) => {
          console.warn('[pano] retract comment vote failed', err);
        },
      });
    } else {
      // Optimistic flip: +1 score, myVote → 1.
      voteCommit({
        variables: {commentId: comment.id},
        optimisticResponse: {
          voteOnComment: {
            id: comment.id,
            score: score + 1,
            myVote: 1,
          },
        },
        onError: (err) => {
          console.warn('[pano] vote on comment failed', err);
        },
      });
    }
  };

  return (
    <article className={cls} id={comment.hash}>
      <header className="kp-comment__head">
        <a className="kp-comment__author" href={`/u/${comment.author}`}>
          @{comment.author}
        </a>
        {comment.isOp ? <span className="kp-comment__op">yazar</span> : null}
        <span>{comment.agoLabel}</span>
        <button
          type="button"
          className={`kp-comment__upvote ${voted ? 'kp-comment__upvote--active' : ''}`}
          aria-pressed={voted}
          aria-label="Yukarı oy"
          onClick={onUpvote}
          data-testid={`comment-vote-${comment.id}`}
        >
          <span className="triangle" />{' '}
          <span data-testid={`comment-score-${comment.id}`}>{score}</span>
        </button>
        <button
          type="button"
          className="kp-comment__collapser"
          onClick={() => setOpen(!open)}
          aria-label={open ? 'Daralt' : 'Genişlet'}
        >
          [ {open ? '—' : '+'} ]
        </button>
      </header>
      {open ? (
        <>
          <div className="kp-comment__body">{comment.body}</div>
          <footer className="kp-comment__foot">
            <button
              type="button"
              onClick={() => onReply?.(comment.id)}
              data-testid={`pano-comment-reply-trigger-${comment.id}`}
            >
              yanıtla
            </button>
            <button type="button">paylaş</button>
            <button type="button">bildir</button>
            {comment.isOwner ? (
              <Menu.Root>
                <Menu.Trigger className="kp-comment__menu-trigger" aria-label="Daha fazla">
                  ⋯
                </Menu.Trigger>
                <Menu.Popup align="start">
                  <Menu.Item onClick={() => onEdit?.(comment.id)}>düzenle</Menu.Item>
                  <Menu.Item>kalıcı bağlantı</Menu.Item>
                  <Menu.Separator />
                  <Menu.Item danger onClick={() => onDelete?.(comment.id)}>
                    sil
                  </Menu.Item>
                </Menu.Popup>
              </Menu.Root>
            ) : null}
          </footer>
          {comment.replyComposer ? (
            <div className="kp-comment__reply" data-testid={`pano-comment-reply-${comment.id}`}>
              {comment.replyComposer}
            </div>
          ) : null}
          {comment.children?.length ? (
            <div>
              {comment.children.map((c) => (
                <PanoComment
                  key={c.id}
                  comment={c}
                  depth={depth + 1}
                  onEdit={onEdit}
                  onDelete={onDelete}
                  onReply={onReply}
                />
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </article>
  );
}

export function PanoCommentTree({
  comments,
  ...handlers
}: {
  comments: CommentData[];
  onEdit?: (id: string) => void;
  onDelete?: (id: string) => void;
  onReply?: (id: string) => void;
}) {
  return (
    <div className="kp-pano-thread">
      {comments.map((c) => (
        <PanoComment key={c.id} comment={c} {...handlers} />
      ))}
    </div>
  );
}
