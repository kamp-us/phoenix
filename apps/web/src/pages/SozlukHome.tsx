import * as React from 'react';
import { Subnav } from '../components/layout/Subnav';
import { SozlukAlphabet, SozlukTermList, type TermRow } from '../components/sozluk/index';

export function SozlukHome({ terms }: { terms: TermRow[] }) {
  const [letter, setLetter] = React.useState<string | undefined>();
  const filtered = letter
    ? terms.filter((t) => t.title.toLowerCase().startsWith(letter))
    : terms;
  return (
    <>
      <Subnav title="sözlük" meta={`${filtered.length} terim`} />
      <div className="kp-page">
        <div className="kp-page__inner">
          <SozlukAlphabet value={letter} onChange={setLetter} />
          <SozlukTermList terms={filtered} />
        </div>
      </div>
    </>
  );
}
