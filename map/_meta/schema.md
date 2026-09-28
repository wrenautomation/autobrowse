# Schema — the rules of this map

Closed set of card types. When practice and this file disagree, reconcile the same day.

## Card types

| `type:` | Lives at | Frontmatter | Sections |
|---|---|---|---|
| object | `objects/<cluster>/<slug>.md` | `cluster`, `universe` (live, leftover, ghost), `status` (stub, verified, stale), `entity` (owning file), `verified` (date @ commit, when status is verified) | one sentence; Why this shape; Shape (with citations); Connected to; If you change this (Hits / Does not hit); Surfaces; See |
| process | `processes/<slug>.md` | `status`, `consumes`, `produces` (object slugs), `verified` | one sentence; Input → Movement → Output; Why this shape; Steps (cited); If you change this; Surfaces; See |

## Rules

- Slugs kebab-case; one noun per card; product word and code name both stated when they differ.
- `verified` needs a date, a commit and at least one `path:line` citation. `stale` is honest; a confident wrong date is not.
- Hits / Does not hit are first-order only. "Does not hit" names the obvious wrong neighbour.
- `[[slug]]` links name another card by its file name without the cluster.
- Generated, never hand-edited: `objects/_index.md`, `AGENTS.md`, `routing.md`. Run `_meta/rebuild.sh` after adding or changing a card or `CLAUDE.md`.
- `pnpm lint` runs `_meta/rebuild.sh --check`: it fails on a stale generated file, a cited file that is gone, or a cited line past the end of its file. It cannot tell a line that moved; re-read a card after editing the code it cites.
