# Podcasting 2.0 — Archive Feed (Eps 1–100)

A back-catalog RSS feed for [Podcasting 2.0](https://podcastindex.org/podcast/920666) — the canonical record of how the PC 2.0 namespace, Value4Value, and Lightning-in-podcasts came together.

The live feed only carries the most recent ~25 items, so eps 1–100 have rolled off. This feed reconstructs them.

## Subscribe

```
https://chadfarrow.github.io/pc20-archive/pc20-archive.xml
```

Paste that URL into any podcast app (Apple Podcasts, Fountain, Podverse, Castamatic, etc.) to subscribe.

## How it works

- Audio enclosures point at `https://mp3s.nashownotes.com/` — the same files Adam Curry has always hosted. No re-hosting of audio.
- Episode metadata (titles, pubDates, show notes) reconstructed from Wayback Machine snapshots of the original `pc20rss.xml`.
- `<podcast:transcript>` and `<podcast:chapters>` tags point at companion `.srt` and `.json` files in the same directory.

## Coverage caveats

- **Eps 1–77** have full Wayback-recovered titles and show notes.
- **Eps 78–100** show as "Episode 78", "Episode 79", … — Wayback's last snapshot of the feed was 2022-03-14, before those episodes aired. PRs welcome with manual title fixes.

## Regenerate

```bash
npm install
MIN_EP=1 MAX_EP=100 MAX_SNAPS=100 VERIFY_LENGTH=1 npx tsx pc20-archive-feed.ts pc20-archive.xml
```

See `pc20-archive-feed.ts` for env vars (`DUMP_FILES`, `DOWNLOAD_DIR`, `DOWNLOAD_ALL`, etc.).
