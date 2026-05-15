# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`pc20-feed` builds a back-catalog Podcasting 2.0 RSS feed for episodes 1–100 of the *Podcasting 2.0* podcast (Adam Curry & Dave Jones). Audio is hosted by Adam at `mp3s.nashownotes.com`; item metadata (titles, pubDates, show notes) is reconstructed from Wayback Machine snapshots of the original `pc20rss.xml`; chapter JSONs that were once served by now-defunct Hypercatcher infrastructure are rehosted from Wayback captures.

Output is `pc20-archive.xml`, served via GitHub Pages at **`https://chadfarrow.github.io/pc20-archive/pc20-archive.xml`**. The repo remote is `ChadFarrow/pc20-archive`; pushing to `main` deploys.

The active PC20 feed (eps 68+) lives at `https://feeds.podcastindex.org/pc20.xml` — this archive complements it for eps 1–67 and re-emits eps 68–100 with working chapter URLs.

## Running

```bash
# Full regenerate (network-heavy: scrapes nashownotes, Wayback CDX, snapshots, HEAD checks)
MIN_EP=1 MAX_EP=100 MAX_SNAPS=100 VERIFY_LENGTH=1 npx tsx pc20-archive-feed.ts pc20-archive.xml

# Inject/refresh <podcast:chapters> tags only — preserves backfilled metadata
npx tsx patch-chapters.ts pc20-archive.xml

# Re-pull chapter JSONs from Wayback (smart-skip on existing files)
npx tsx fetch-archived-chapters.ts
```

`npm run build` is wired to `tsx pc20-archive-feed.ts pc20-archive.xml` with defaults (`MIN_EP=1 MAX_EP=67`).

Env vars accepted by `pc20-archive-feed.ts`: `MIN_EP`, `MAX_EP`, `MAX_SNAPS`, `VERIFY_LENGTH`, `DUMP_FILES`, `DOWNLOAD_DIR`, `DOWNLOAD_ALL`.

## Files

- **`pc20-archive-feed.ts`** — builder. ~470 lines, no abstractions worth chasing. Five-stage pipeline (see below). Channel-level constants live at the top: `INDEX_URL`, `FEED_URL`, `ART_URL`, `REHOST_BASE`, `REHOST_DIR`, `VALUE_RECIPIENTS`, `FUNDING_URL`, `FUNDING_LABEL`.
- **`fetch-archived-chapters.ts`** — one-shot. Hits Wayback CDX for `chapters.hypercatcher.com/` and `studio.hypercatcher.com/chapters/podcast/` PC20 captures, downloads each archived JSON via the `id_/` Wayback URL form (unrewritten content), writes to `chapters/PC20-{N}-Chapters.json` and mirrors to `/Volumes/NAS/pc20-archive/`. 6 s pacing, 30 s timeout, retries on connect timeouts / 429s.
- **`patch-chapters.ts`** — surgical XML injector. Walks `<item>` blocks in `pc20-archive.xml`, finds each `<itunes:episode>N</itunes:episode>`, and if `chapters/PC20-N-Chapters.json` exists locally without an existing `<podcast:chapters>` tag, inserts one pointing at the GitHub Pages mirror. Use whenever Wayback is rate-limited and a full regen would lose backfilled metadata.
- **`chapters/`** — repo-tracked chapter JSONs (80 files: eps 12, 23, 68–145). Served by Pages at `chadfarrow.github.io/pc20-archive/chapters/PC20-{N}-Chapters.json`. Also mirrored to NAS.
- **`pc20-archive.xml`** — generated output. Currently covers eps 1–100. **Edit by patching, not regenerating** unless you know Wayback is healthy (see Gotchas).
- **`cover.jpg`** — 3000×3000 channel artwork, served at `chadfarrow.github.io/pc20-archive/cover.jpg`.

## Build pipeline (`pc20-archive-feed.ts`)

1. **`scrapeIndex()`** — Fetches the nginx autoindex at `mp3s.nashownotes.com/` and classifies every `PC20-*` file (`audio` / `transcript` / `captions` / `chapters` / `other`). Extracts mtime from the autoindex segments. `.mp3` filenames encode pubDate (`PC20-{NN}-YYYY-MM-DD-*.mp3`).
2. **`bundle()`** + **`rehostedChapters()`** — Group files by episode. Then read `chapters/` and synthesize `Pc20File` entries pointing at the GitHub Pages mirror; these merge into each bundle's `chapters[]`. Local-on-nashownotes chapters win over rehosted ones because they have `mtime` (rehosted entries don't).
3. **`buildMetaMap()`** — Fetches up to `MAX_SNAPS` Wayback snapshots of `mp3s.nashownotes.com/pc20rss.xml` via CDX. For each snapshot, parses `<item>`s with `fast-xml-parser` (`isArray: (n) => n === "item"`) and indexes them by the mp3 filename. **First snapshot wins** — earlier snapshots take precedence over later ones for title/pubDate/showNotes. The CDX endpoint can rate-limit; `parseSnapshot` swallows individual snapshot failures silently, but `listSnapshots` does not.
4. **`fillLengths()`** — Optional. `HEAD` every audio URL to populate `length=""` on enclosures. Concurrency 6.
5. **`buildFeed()`** — Emits RSS 2.0 + `itunes:` + `podcast:` + `content:` namespaces. Channel header includes `<podcast:value>` (from `VALUE_RECIPIENTS`), `<podcast:funding>`, `<podcast:guid>`, `<podcast:medium>`, `<podcast:remoteItem>` (pointing at the canonical PC20 feed). Each `<item>` carries `<podcast:transcript>` and optional `<podcast:chapters>`.

## Chapter recovery — what's recoverable, what isn't

| Source | Episodes | Status |
|---|---|---|
| `mp3s.nashownotes.com/` (live)            | ep 11, ep 260                | 200 ✓ |
| Wayback `studio.hypercatcher.com/chapters/podcast/` | eps 12, 23                   | rehosted to repo + NAS |
| Wayback `chapters.hypercatcher.com/`      | eps 68–145                   | rehosted to repo + NAS |
| Active feed bare-IP `http://34.117.70.159/` | eps 68–~141 (URLs only)      | host dead; **do not emit** |
| Active feed `reflex.livewire.io`          | eps ~173–260 (proxy URLs)    | live but pure passthrough, no cache |

Eps **1–10, 13–22, 24–67** have no recoverable chapter JSONs anywhere on the public web. The pre-Hypercatcher era simply isn't archived. Filling that gap requires contacting Dreb Scott (`drebscott@getalby.com`, credited as the chapters author in the active feed's value split).

When emitting chapter URLs, the only acceptable hosts are `mp3s.nashownotes.com` (live) and `chadfarrow.github.io` (rehosted). Never emit Wayback URLs containing dead upstreams (`34.117.70.159`, `studio.hypercatcher.com`, `chapters.hypercatcher.com`) — they 404 or refuse to connect.

## Value-4-Value

`<podcast:value>` is **channel-level only** in this feed (applies to every `<item>` unless overridden). The recipient list is encoded as `VALUE_RECIPIENTS` in `pc20-archive-feed.ts` and copied verbatim from the active feed's channel-level block. `split` is **proportional shares, not percent** — the 7 recipients sum to 110 (92+5+5+1+1+1+5).

Spec: https://podcasting2.org/docs/podcast-namespace/tags/value and `/tags/value-recipient`.

Skipped intentionally:
- Per-item `<podcast:value>` — Wayback shows the early-era feed had **zero** item-level value blocks; reconstruction would be guesswork against possibly-dead wallets.
- `<podcast:locked>` — that tag is for the canonical feed owner, not a community archive.
- `<podcast:complete>` — could be `yes` if you consider 1–100 frozen, but it's a separate decision.

## NAS mirror

`fetch-archived-chapters.ts` writes every downloaded chapter JSON to both `chapters/` (the repo) and `/Volumes/NAS/pc20-archive/` (SMB share at `192.168.0.81/pc20-archive`, auto-mounted by macOS). The NAS already holds the source mp3s + captions for every PC20 episode; chapter JSONs live alongside as `PC20-{N}-Chapters.json`.

The NAS write is conditional on `existsSync("/Volumes/NAS/pc20-archive")` — if you're working off-network it silently skips, which is fine.

## Deploying

GitHub Pages serves `main`. Push → ~60–90 s rebuild → live at `chadfarrow.github.io/pc20-archive/`. Validate end-to-end with:

```bash
curl -s https://chadfarrow.github.io/pc20-archive/pc20-archive.xml | grep -cE "podcast:(chapters|value|funding)"
```

## Gotchas

- **Full regenerate + Wayback rate-limit = title regression.** Commit `91bc19e` hand-backfilled titles/pubDates/show notes for eps 78–100; a from-scratch build with rate-limited snapshot fetches drops those items back to placeholder `<title>Episode N</title>`. **Prefer `patch-chapters.ts` for chapter-only updates.** If you must regenerate, watch the `[2/4]` line — it should say `collected metadata for 100 items`. Anything less means metadata was lost and you should not commit the result.
- **`feeds.podcastindex.org` rejects `curl/7.x`** with HTTP 403. Always send a real `User-Agent` (`Mozilla/5.0 ...`) when fetching it.
- **Wayback CDX has no built-in pacing.** Heavy parallel use (e.g. running `fetch-archived-chapters.ts` followed immediately by a full build) trips a 429 that takes ~5 minutes to clear. The CDX endpoint returns HTML during rate-limit, which `listSnapshots` will then `JSON.parse` and crash on.
- **"First snapshot wins" in `buildMetaMap`.** A later snapshot's richer metadata (e.g. an added chapters URL) is ignored if the same mp3 filename appeared in an earlier snapshot. Pre-existing behavior; flag if you ever need to change it.
- **`<podcast:guid>` is hardcoded** as `pc20-archive-${range.min}-${range.max}`. Changing `MIN_EP`/`MAX_EP` changes the GUID, which apps treat as a different podcast. Don't randomize the range without intent.
- **GitHub Pages is case-sensitive** even on macOS hosts — `PC20-68-Chapters.json` ≠ `PC20-68-chapters.json`. The downloader and the builder both expect the capital-C form (`PC20-{N}-Chapters.json`).
