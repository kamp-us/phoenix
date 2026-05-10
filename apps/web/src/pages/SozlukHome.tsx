import * as React from 'react';
import { graphql, useLazyLoadQuery } from 'react-relay';
import type { SozlukHomeRecentQuery } from '../__generated__/SozlukHomeRecentQuery.graphql';
import type { SozlukHomePopularQuery } from '../__generated__/SozlukHomePopularQuery.graphql';
import {
  SozlukAlphabet,
  SozlukPopular,
  SozlukTermList,
} from '../components/sozluk/index';
import { QueryBoundary } from '../relay/QueryBoundary';
import './SozlukHome.css';

const RecentQuery = graphql`
  query SozlukHomeRecentQuery {
    terms(sort: recent, limit: 24) {
      id
      slug
      title
      count
      excerpt
      totalScore
    }
  }
`;

const PopularQuery = graphql`
  query SozlukHomePopularQuery {
    terms(sort: popular, limit: 10) {
      id
      slug
      title
      totalScore
    }
  }
`;

type RecentTerm = SozlukHomeRecentQuery['response']['terms'][number];
type PopularTermNode = SozlukHomePopularQuery['response']['terms'][number];

export function SozlukHome() {
  const [letter, setLetter] = React.useState<string | undefined>();
  const [query, setQuery] = React.useState('');

  return (
    <div className="kp-page">
      <div className="kp-page__inner">
        <QueryBoundary
          loading={
            <SozlukHomeChrome
              letter={letter}
              query={query}
              setLetter={setLetter}
              setQuery={setQuery}
              status="loading"
              recent={[]}
              popular={[]}
            />
          }
          error={(err) => (
            <SozlukHomeChrome
              letter={letter}
              query={query}
              setLetter={setLetter}
              setQuery={setQuery}
              status="error"
              errorMessage={err.message}
              recent={[]}
              popular={[]}
            />
          )}
        >
          <SozlukHomeContent
            letter={letter}
            query={query}
            setLetter={setLetter}
            setQuery={setQuery}
          />
        </QueryBoundary>
      </div>
    </div>
  );
}

interface ContentProps {
  letter: string | undefined;
  query: string;
  setLetter: (l: string) => void;
  setQuery: (q: string) => void;
}

function SozlukHomeContent({letter, query, setLetter, setQuery}: ContentProps) {
  const recentData = useLazyLoadQuery<SozlukHomeRecentQuery>(RecentQuery, {});
  const popularData = useLazyLoadQuery<SozlukHomePopularQuery>(PopularQuery, {});

  return (
    <SozlukHomeChrome
      letter={letter}
      query={query}
      setLetter={setLetter}
      setQuery={setQuery}
      status="ok"
      recent={recentData.terms}
      popular={popularData.terms}
    />
  );
}

interface ChromeProps extends ContentProps {
  status: 'loading' | 'ok' | 'error';
  errorMessage?: string;
  recent: ReadonlyArray<RecentTerm>;
  popular: ReadonlyArray<PopularTermNode>;
}

function SozlukHomeChrome({
  letter,
  query,
  setLetter,
  setQuery,
  status,
  errorMessage,
  recent,
  popular,
}: ChromeProps) {
  const filtered = recent.filter((t) => {
    if (letter && !t.title.toLowerCase().startsWith(letter)) return false;
    if (query && !t.title.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  });

  const totalsLine =
    status === 'ok'
      ? `${recent.length} terim · son 24 sa: ${recent.length} yeni`
      : status === 'loading'
      ? 'yükleniyor…'
      : 'yüklenemedi';

  return (
    <>
      <header className="kp-sozluk-home__masthead">
        <div>
          <h1 className="kp-sozluk-home__title">
            sözlük <small>{totalsLine}</small>
          </h1>
        </div>
        <label className="kp-sozluk-home__searchbar">
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            aria-hidden
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder="terim ara: race condition, idempotent…"
            aria-label="Terim ara"
          />
        </label>
      </header>

      <SozlukAlphabet value={letter} onChange={setLetter} />

      {status === 'error' ? (
        <p style={{font: 'var(--t-meta)', color: 'var(--danger)', padding: 'var(--s-3) 0'}}>
          sözlük yüklenemedi: {errorMessage}
        </p>
      ) : null}

      <div className="kp-sozluk-home__columns">
        <section>
          <header className="kp-sozluk-home__col-head">
            <span className="title">son eklenenler</span>
            <span>24 sa</span>
          </header>
          <SozlukTermList terms={filtered.map((t) => ({
            slug: t.slug,
            title: t.title,
            count: t.count,
            excerpt: t.excerpt ?? undefined,
          }))} />
        </section>

        <section>
          <header className="kp-sozluk-home__col-head">
            <span className="title">en çok oylananlar</span>
            <span>tüm zamanlar</span>
          </header>
          <SozlukPopular terms={popular.map((t) => ({
            slug: t.slug,
            title: t.title,
            totalScore: t.totalScore,
          }))} />
        </section>
      </div>
    </>
  );
}
