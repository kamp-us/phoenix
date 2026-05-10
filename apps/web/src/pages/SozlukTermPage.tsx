import * as React from 'react';
import { graphql, useLazyLoadQuery } from 'react-relay';
import { Link, useParams } from 'react-router';
import type { SozlukTermPageQuery } from '../__generated__/SozlukTermPageQuery.graphql';
import { Button } from '../components/ui/Button';
import { formatAgoTR, formatDateTR } from '../lib/datetime';
import { renderMarkdownInline, splitMarkdownBlocks } from '../lib/markdown';
import { QueryBoundary } from '../relay/QueryBoundary';
import './SozlukTermPage.css';

const TermQuery = graphql`
  query SozlukTermPageQuery($slug: String!) {
    term(slug: $slug) {
      id
      slug
      title
      count
      totalScore
      firstAt
      lastEdit
      definitions {
        id
        body
        author
        score
        createdAt
        updatedAt
      }
    }
  }
`;

type TermNode = NonNullable<SozlukTermPageQuery['response']['term']>;
type DefinitionNode = TermNode['definitions'][number];

export function SozlukTermPage() {
  const { slug } = useParams<{ slug: string }>();
  const safeSlug = slug ?? '';

  return (
    <div className="kp-page">
      <div className="kp-page__inner">
        <QueryBoundary
          loading={
            <p style={{font: 'var(--t-meta)', color: 'var(--text-muted)'}}>yükleniyor…</p>
          }
          error={(err) => (
            <p style={{font: 'var(--t-body)', color: 'var(--danger)'}}>
              terim yüklenemedi: {err.message}
            </p>
          )}
        >
          <SozlukTermContent slug={safeSlug} />
        </QueryBoundary>
      </div>
    </div>
  );
}

function SozlukTermContent({slug}: {slug: string}) {
  const data = useLazyLoadQuery<SozlukTermPageQuery>(TermQuery, {slug});
  const term = data.term;

  if (!term) {
    return (
      <p style={{font: 'var(--t-body)', color: 'var(--text-muted)'}}>
        "{slug}" terimi henüz yok. <Link to="/sozluk">sözlüğe dön</Link>
      </p>
    );
  }

  const firstLetter = term.title.charAt(0).toLowerCase();

  return (
    <>
      <header className="kp-sozluk-term__head">
        <p className="kp-sozluk-term__crumbs">
          <Link to="/sozluk">sözlük</Link> / <Link to="/sozluk">{firstLetter}</Link> /{' '}
          {term.title}
        </p>
        <h1 className="kp-sozluk-term__title">{term.title}</h1>
        <div className="kp-sozluk-term__meta">
          <span>{term.count} tanım</span>
          <span>{term.totalScore} oy</span>
          {term.firstAt ? <span>ilk: {formatDateTR(term.firstAt)}</span> : null}
          {term.lastEdit ? <span>son düzenleme: {formatAgoTR(term.lastEdit)}</span> : null}
        </div>
      </header>

      {term.definitions.map((d, i) => (
        <DefinitionCard key={d.id} definition={d} rank={i + 1} top={i === 0} />
      ))}

      <Composer />
    </>
  );
}

function DefinitionCard({
  definition,
  rank,
  top,
}: {
  definition: DefinitionNode;
  rank: number;
  top: boolean;
}) {
  const [voted, setVoted] = React.useState(false);
  const cls = top
    ? 'kp-sozluk-definition kp-sozluk-definition--top'
    : 'kp-sozluk-definition';

  return (
    <article className={cls}>
      <div className="kp-sozluk-definition__vote">
        <button
          type="button"
          className="kp-sozluk-definition__vote-btn"
          aria-pressed={voted}
          aria-label="Yukarı oy"
          onClick={() => setVoted(!voted)}
        >
          <span className="triangle" />
        </button>
        <span className="kp-sozluk-definition__vote-count">{definition.score}</span>
        <span className="kp-sozluk-definition__rank">#{rank}</span>
      </div>
      <div>
        <Body text={definition.body} />
        <footer className="kp-sozluk-definition__foot">
          <span className="author">@{definition.author}</span>
          <span className="dot">·</span>
          <span>{formatAgoTR(definition.createdAt)}</span>
          <span className="actions">
            <button type="button">paylaş</button>
            <button type="button">kalıcı bağlantı</button>
            <button type="button">bildir</button>
          </span>
        </footer>
      </div>
    </article>
  );
}

/**
 * Definition body — split paragraphs on blank lines, fenced code as <pre>,
 * inline `code` and **strong** via the shared lib/markdown helpers. A real
 * markdown renderer (react-markdown + sanitizer) replaces this when content
 * gets richer.
 */
function Body({ text }: { text: string }) {
  const blocks = splitMarkdownBlocks(text);
  return (
    <div className="kp-sozluk-definition__body">
      {blocks.map((block, i) => {
        if (block.kind === 'code') {
          return <pre key={i}>{block.text}</pre>;
        }
        return <p key={i}>{renderMarkdownInline(block.text)}</p>;
      })}
    </div>
  );
}

function Composer() {
  return (
    <form
      className="kp-sozluk-composer"
      onSubmit={(e) => {
        e.preventDefault();
      }}
    >
      <header className="kp-sozluk-composer__head">
        <span className="kp-sozluk-composer__title">sen nasıl tanımlardın?</span>
      </header>
      <textarea
        className="kp-sozluk-composer__textarea"
        placeholder="markdown destekli. ```js ... ``` kod bloğu için. kişisel deneyim, örnek, hatıra; kuru sözlük tanımı zaten Wikipedia'da var."
      />
      <footer className="kp-sozluk-composer__foot">
        <span className="kp-sozluk-composer__hint">
          markdown · <kbd>⌘</kbd>+<kbd>↵</kbd> gönder
        </span>
        <span style={{display: 'flex', gap: 6}}>
          <Button variant="tertiary" size="sm" type="button">
            iptal
          </Button>
          <Button variant="primary" size="sm" type="submit">
            tanımı ekle
          </Button>
        </span>
      </footer>
    </form>
  );
}
