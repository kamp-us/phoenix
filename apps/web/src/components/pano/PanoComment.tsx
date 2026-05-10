import * as React from 'react';
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

export function PanoComment({
  comment,
  depth = 0,
  onVote,
  onEdit,
  onDelete,
  onReply,
}: {
  comment: CommentData;
  depth?: number;
  onVote?: (id: string, d: -1 | 1) => void;
  onEdit?: (id: string) => void;
  onDelete?: (id: string) => void;
  onReply?: (id: string) => void;
}) {
  const [open, setOpen] = React.useState(true);
  const [voted, setVoted] = React.useState((comment.myVote ?? 0) === 1);
  const cls = [
    'kp-comment',
    depth === 1 ? 'kp-comment--depth-1' : '',
    depth >= 2 ? 'kp-comment--depth-2' : '',
    comment.highlight ? 'kp-comment--highlighted' : '',
  ].filter(Boolean).join(' ');

  const score = comment.score + (voted && (comment.myVote ?? 0) !== 1 ? 1 : 0);

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
          onClick={() => {
            setVoted(!voted);
            onVote?.(comment.id, 1);
          }}
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
                  onVote={onVote}
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
  onVote?: (id: string, d: -1 | 1) => void;
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
