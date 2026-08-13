# fixture domain vocabulary (TERMS)

A committed fixture register. It exists so the `glossary` contract's examples resolve against a
corpus that does not move, and it deliberately carries two planted defects — a duplicate key and a
citation to a superseded decision — so `glossary check` has something to find.

## Core / shape

| Term | Definition | Not |
|---|---|---|
| pano | The board product. Planted duplicate: also declared under Products (domains). | |
| worker | The single edge worker serving the app and the API. Cites 0044. | "server" |

## Products (domains)

| Term | Definition | Not |
|---|---|---|
| depo | The internal asset store. | the public image product |
| pano | The board product, declared a second time on purpose. | |
| sozluk | The community dictionary product. | "dictionary" |

## Indexing

| Term | Definition | Not |
|---|---|---|
| Database (tag) | The storage engine's row-version marker, written to detect concurrent writes. | a user-applied label on a document |
