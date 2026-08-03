# Issue #4901 — `status:needs-triage`, open

**Title:** Bildirim gönder: birisi entry'ne cevap yazınca haber ver

**Author:** usirin

**Body:**

## Summary
Right now if someone replies to your sözlük entry you only find out by going back and looking. We
should tell people when it happens.

## What I was doing
Reading through the pano feed and noticed I'd missed three replies to an entry I wrote last week.

## What I observed
There is no notification of any kind in the product. `apps/web/worker/features/` has no notification
feature directory, and nothing in the worker sends mail.

## Why it matters
People write an entry, get a reply, and never see it. That is the whole loop of a sözlük not closing.

## Pointers
- `apps/web/worker/features/sozluk/`
- the reply path lives near the definition create mutation

## Suggested next step (non-binding)
Send an email when a reply lands. Maybe also show a badge somewhere in the header.

<sub>Filed by an agent · session 9c21 · claude-opus-5</sub>
