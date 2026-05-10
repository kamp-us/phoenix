import * as React from 'react';
import { Avatar } from '../ui/Avatar';
import { Menu } from '../ui/Menu';
import { Collapsible } from '../ui/Collapsible';
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
  const style = { ['--depth' as any]: depth };

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <article
        className="kp-comment"
        style={style}
        data-highlight={comment.highlight ? '' : undefined}
      >
        <header className="kp-comment__head">
          <Collapsible.Trigger open={open} />
          <Avatar name={comment.author} />
          <a href={`/u/${comment.author}`} className="kp-comment__author">
            @{comment.author}
          </a>
          <span>·</span>
          <span>{comment.agoLabel}</span>
          <span>·</span>
          <span>{comment.score} puan</span>
          {comment.hash ? (
            <a href={`#${comment.hash}`} className="kp-comment__hash">#{comment.hash}</a>
          ) : null}
        </header>
        <Collapsible.Panel>
          <div className="kp-comment__body">{comment.body}</div>
          <footer className="kp-comment__foot">
            <button onClick={() => onReply?.(comment.id)}>yanıtla</button>
            {comment.isOwner ? (
              <Menu.Root>
                <Menu.Trigger className="kp-btn kp-btn--tertiary kp-btn--sm">
                  ⋯
                </Menu.Trigger>
                <Menu.Popup align="start">
                  <Menu.Item onClick={() => onEdit?.(comment.id)}>düzenle</Menu.Item>
                  <Menu.Item>kalıcı bağlantı</Menu.Item>
                  <Menu.Separator />
                  <Menu.Item danger onClick={() => onDelete?.(comment.id)}>sil</Menu.Item>
                </Menu.Popup>
              </Menu.Root>
            ) : null}
          </footer>
          {comment.children?.length ? (
            <div>
              {comment.children.map((c) => (
                <PanoComment
                  key={c.id} comment={c} depth={depth + 1}
                  onVote={onVote} onEdit={onEdit}
                  onDelete={onDelete} onReply={onReply}
                />
              ))}
            </div>
          ) : null}
        </Collapsible.Panel>
      </article>
    </Collapsible.Root>
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
    <div className="kp-comment-list">
      {comments.map((c) => (
        <PanoComment key={c.id} comment={c} {...handlers} />
      ))}
    </div>
  );
}
