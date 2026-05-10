import * as React from 'react';
import { graphql, useMutation } from 'react-relay';
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
  myVote?: -1 | 0 | 1;
  isOwner?: boolean;
  isOp?: boolean;
  highlight?: boolean;  /* hash-targeted */
  children?: CommentData[];
};

const CommentVoteMutation = graphql`
  mutation PanoCommentVoteMutation($input: VoteInput!) {
    voteOnComment(input: $input) {
      score
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
  const [open, setOpen] = React.useState(true);
  const [voted, setVoted] = React.useState((comment.myVote ?? 0) === 1);
  const [delta, setDelta] = React.useState(0);
  const [commit, isInFlight] = useMutation<PanoCommentVoteMutation>(CommentVoteMutation);

  const cls = [
    'kp-comment',
    depth === 1 ? 'kp-comment--depth-1' : '',
    depth >= 2 ? 'kp-comment--depth-2' : '',
    comment.highlight ? 'kp-comment--highlighted' : '',
  ].filter(Boolean).join(' ');

  const score = comment.score + delta;

  const onUpvote = () => {
    if (!session.data?.user) {
      console.warn('[pano] vote requires sign-in');
      return;
    }
    if (isInFlight) return;
    const nextVoted = !voted;
    const nextValue: 0 | 1 = nextVoted ? 1 : 0;
    const nextDelta = nextValue - (voted ? 1 : 0);
    setVoted(nextVoted);
    setDelta((d) => d + nextDelta);
    commit({
      variables: {input: {targetId: comment.id, value: nextValue}},
      onError: () => {
        setVoted(voted);
        setDelta((d) => d - nextDelta);
      },
    });
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
        >
          <span className="triangle" /> {score}
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
            <button type="button" onClick={() => onReply?.(comment.id)}>
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
