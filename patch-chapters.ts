/**
 * patch-chapters.ts
 *
 * Surgically inject <podcast:chapters> tags into pc20-archive.xml for every
 * episode that has a local chapters/PC20-{ep}-Chapters.json file, without
 * regenerating the rest of the feed. Used when the full builder would lose
 * already-backfilled metadata (e.g. when Wayback rate-limits mid-build).
 *
 * Rules:
 *   - If the item already has a <podcast:chapters> tag, leave it.
 *   - Otherwise insert one pointing at the GitHub Pages mirror, placed right
 *     before </item>, indented to match surrounding lines.
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";

const FEED_PATH = process.argv[2] ?? "pc20-archive.xml";
const REHOST_BASE = "https://chadfarrow.github.io/pc20-archive/chapters/";
const REHOST_DIR = "chapters";

function rehostedEpisodes(): Set<number> {
  const eps = new Set<number>();
  for (const filename of readdirSync(REHOST_DIR)) {
    const m = filename.match(/^PC20-(\d{1,4})-Chapters\.json$/i);
    if (m) eps.add(parseInt(m[1], 10));
  }
  return eps;
}

const xml = readFileSync(FEED_PATH, "utf8");
const eps = rehostedEpisodes();

let patched = xml;
let injected = 0;
let already = 0;

patched = patched.replace(/<item>([\s\S]*?)<\/item>/g, (block) => {
  const epMatch = block.match(/<itunes:episode>(\d+)<\/itunes:episode>/);
  if (!epMatch) return block;
  const ep = parseInt(epMatch[1], 10);
  if (!eps.has(ep)) return block;
  if (/<podcast:chapters\s/.test(block)) {
    already++;
    return block;
  }
  const url = `${REHOST_BASE}PC20-${ep}-Chapters.json`;
  const tag = `      <podcast:chapters url="${url}" type="application/json+chapters"/>\n    `;
  injected++;
  return block.replace(/(\s*)<\/item>/, `\n${tag}</item>`);
});

writeFileSync(FEED_PATH, patched);
console.error(`patched ${FEED_PATH}: injected ${injected} chapter tag(s), ${already} already present, ${eps.size - injected - already} skipped`);
