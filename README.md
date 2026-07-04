# kamp.us

**geliştiricilerin kendi kendine bir şey öğrettiği, yavaş bir köşe.** — a slow corner of the internet where developers teach themselves and each other. Turkish-first; no ads, no follower counts, no outrage — just things worth reading and the few hundred people who write them.

kamp.us is a community built around two products:

- **pano** — a link and discussion board. We share links and writing, and we argue about them (*panoda bağlantı ve yazı paylaşıyor, tartışıyoruz*).
- **sözlük** — a dictionary written in our own words, one term and one definition at a time (*sözlükte terimleri kendi cümlelerimizle yazıyoruz*).

## Söz hakkı kazanılır — the çaylak → yazar rite

The door is open, but the right to speak is earned.

- **kapı açık** — anyone can open an account.
- **söz hakkı kazanılır** — what you first write goes up as a **çaylak** (newcomer), reviewed on the **divan** — the gated reviewer surface where a **yazar** (author) and a **moderatör** look over a newcomer's sandboxed work. As you contribute, a yazar vouches for you; you become a yazar yourself, and from then on what you write goes straight to publication.

This earned-authorship rite is the spine of the community: it keeps the corner slow and the writing worth reading, instead of trading quality for reach. (See issues [#1202](https://github.com/kamp-us/phoenix/issues/1202) and [#1667](https://github.com/kamp-us/phoenix/issues/1667) for the framing.)

## The ethos

- **Türkçe öncelikli** — Turkish-first for everything a person reads and writes.
- **No ads, no follower counts, no sensation** — the incentives that make the rest of the internet loud are simply absent here.
- **A slow corner** — depth over volume; a few hundred people who care over a crowd that doesn't.

The full product/brand vocabulary — sözlük, pano, kampus, künye, divan, and the rest — lives in [`.glossary/LANGUAGE.md`](./.glossary/LANGUAGE.md).

## Developing on this?

kamp.us runs on **phoenix**: a single Cloudflare Worker on alchemy + Effect + fate that serves the SPA, the data plane, and every backend route. If you're here to build — quickstart, stack, architecture, commands, conventions, and the agent-operable pipeline — read **[DEVELOPMENT.md](./DEVELOPMENT.md)**.
