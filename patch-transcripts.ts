/**
 * patch-transcripts.ts
 *
 * Point <podcast:transcript rel="captions"> at the GitHub Pages mirror for every
 * episode that has a local captions/PC20-{ep}-Captions.srt, without
 * regenerating the rest of the feed. The transcript twin of patch-chapters.ts.
 *
 * captions/ holds only what transcribe.mjs made for episodes whose server
 * captions are a "Transcript is Processing" placeholder, a copy of another
 * episode's transcript, or missing — so a local file always wins.
 *
 * Rules:
 *   - A captions tag pointing elsewhere gets its url replaced.
 *   - An item with no captions tag gets one, right before </item>.
 *   - A tag already pointing at the mirror is left alone.
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";

const FEED_PATH = process.argv[2] ?? "pc20-archive.xml";
const CAPTIONS_BASE = "https://chadfarrow.github.io/pc20-archive/captions/";
const CAPTIONS_DIR = "captions";

function localCaptions(): Map<number, string> {
  const eps = new Map<number, string>();
  for (const filename of readdirSync(CAPTIONS_DIR)) {
    const m = filename.match(/^PC20-0*(\d{1,4})-Captions\.srt$/);
    if (m) eps.set(parseInt(m[1], 10), filename);
  }
  return eps;
}

const xml = readFileSync(FEED_PATH, "utf8");
const eps = localCaptions();

let replaced = 0;
let injected = 0;
let already = 0;

const patched = xml.replace(/<item>([\s\S]*?)<\/item>/g, (block) => {
  const epMatch = block.match(/<itunes:episode>(\d+)<\/itunes:episode>/);
  if (!epMatch) return block;
  const filename = eps.get(parseInt(epMatch[1], 10));
  if (!filename) return block;
  const url = CAPTIONS_BASE + encodeURIComponent(filename);

  const tag = /<podcast:transcript url="([^"]*)"[^>]*rel="captions"\/>/;
  const found = block.match(tag);
  if (found) {
    if (found[1] === url) {
      already++;
      return block;
    }
    replaced++;
    return block.replace(tag, `<podcast:transcript url="${url}" type="application/srt" rel="captions"/>`);
  }
  injected++;
  return block.replace(
    /(\s*)<\/item>/,
    `\n      <podcast:transcript url="${url}" type="application/srt" rel="captions"/>\n    </item>`
  );
});

writeFileSync(FEED_PATH, patched);
console.error(
  `patched ${FEED_PATH}: replaced ${replaced}, injected ${injected}, ${already} already present, ` +
    `${eps.size - replaced - injected - already} not in the feed`
);
