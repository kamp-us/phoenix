import * as React from 'react';
import { SozlukAlphabet, SozlukTermList, type TermRow } from '../components/sozluk/index';
import { Subnav } from '../components/layout/Subnav';
export function SozlukHome({ terms }: { terms: TermRow[] }) {
  const [letter, setLetter] = React.useState<string | undefined>();
  const filtered = letter
    ? terms.filter((t) => t.title.toLowerCase().startsWith(letter))
    : terms;
  return (
    <>
      <Subnav title="sözlük" count={`${filtered.length} terim`} />
      <SozlukAlphabet value={letter} onChange={setLetter} />
      <SozlukTermList terms={filtered} />
    </>
  );
}
