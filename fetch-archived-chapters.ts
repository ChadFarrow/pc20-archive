/**
 * fetch-archived-chapters.ts
 *
 * One-shot: pull PC20 chapter JSONs that were once served by Hypercatcher
 * but whose hosts are now dead. Wayback Machine has them archived under
 *   - https://chapters.hypercatcher.com/http%3Amp3s.nashownotes.compc20rss.xml/PC20{NN}
 *   - https://studio.hypercatcher.com/chapters/podcast/http:mp3s.nashownotes.compc20rss.xml/episode/PC20{NN}
 *
 * Downloads each via the id_/ Wayback URL form (unrewritten content) and
 * writes to chapters/PC20-{ep}-Chapters.json. Paces requests to avoid 429s.
 *
 * Run:
 *   npx tsx fetch-archived-chapters.ts
 */

import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const UA = "Mozilla/5.0 pc20-archive-recovery (+https://github.com/ChadFarrow/pc20-archive)";
const OUT_DIR = "chapters";
const NAS_DIR = "/Volumes/NAS/pc20-archive";
const DELAY_MS = 6000;       // between successful fetches
const RETRY_DELAY_MS = 60000; // on 429
const MAX_RETRIES = 3;

type Capture = { timestamp: string; original: string; episode: number };

async function cdxSearch(urlPrefix: string): Promise<Capture[]> {
  const cdx =
    `https://web.archive.org/cdx/search/cdx?` +
    `url=${encodeURIComponent(urlPrefix)}&matchType=prefix&output=json` +
    `&fl=timestamp,original&filter=statuscode:200&filter=mimetype:application/(json|octet-stream)` +
    `&filter=original:.*PC20.*&collapse=original`;
  const rows = (await fetch(cdx, { headers: { "User-Agent": UA } }).then((r) =>
    r.json()
  )) as string[][];
  rows.shift(); // header
  const captures: Capture[] = [];
  for (const [timestamp, original] of rows) {
    const m = original.match(/PC20-?(\d{1,4})(?:\D|$)/);
    if (!m) continue;
    const episode = parseInt(m[1], 10);
    if (!Number.isFinite(episode)) continue;
    captures.push({ timestamp, original, episode });
  }
  return captures;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function fetchArchived(c: Capture): Promise<{ ok: boolean; body?: string; status?: number }> {
  const url = `https://web.archive.org/web/${c.timestamp}id_/${c.original}`;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(30_000),
      });
      const body = await res.text();
      if (res.status === 200 && !body.startsWith("<")) {
        return { ok: true, body, status: 200 };
      }
      if (res.status === 429) {
        console.error(`  ep ${c.episode}: 429, sleeping ${RETRY_DELAY_MS / 1000}s (attempt ${attempt}/${MAX_RETRIES})`);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      return { ok: false, status: res.status, body };
    } catch (e: any) {
      console.error(`  ep ${c.episode}: network error (${e?.cause?.code ?? e?.name ?? "unknown"}), retry ${attempt}/${MAX_RETRIES} in 30s`);
      await new Promise((r) => setTimeout(r, 30_000));
    }
  }
  return { ok: false, status: 0 };
}

function isValidChaptersJson(body: string): boolean {
  try {
    const j = JSON.parse(body);
    return Array.isArray(j?.chapters);
  } catch {
    return false;
  }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  console.error("[1/3] CDX query: chapters.hypercatcher.com");
  const a = await cdxSearch("chapters.hypercatcher.com/");
  console.error(`      found ${a.length} captures`);

  console.error("[2/3] CDX query: studio.hypercatcher.com");
  const b = await cdxSearch("studio.hypercatcher.com/chapters/podcast/");
  console.error(`      found ${b.length} captures`);

  // Prefer chapters.hypercatcher.com over studio.* when both have the same episode.
  const byEp = new Map<number, Capture>();
  for (const c of [...b, ...a]) byEp.set(c.episode, c);
  const captures = [...byEp.values()].sort((x, y) => x.episode - y.episode);

  console.error(`[3/3] downloading ${captures.length} episodes…`);
  let ok = 0, skipped = 0, failed = 0;
  for (const c of captures) {
    const dest = join(OUT_DIR, `PC20-${c.episode}-Chapters.json`);
    if (await fileExists(dest)) {
      const existing = await readFile(dest, "utf8");
      if (isValidChaptersJson(existing)) {
        skipped++;
        continue;
      }
    }
    const res = await fetchArchived(c);
    if (!res.ok || !res.body || !isValidChaptersJson(res.body)) {
      failed++;
      console.error(`  ep ${c.episode}: FAIL  status=${res.status} url=${c.original}`);
      continue;
    }
    // pretty-print to normalize formatting and validate JSON
    const parsed = JSON.parse(res.body);
    const pretty = JSON.stringify(parsed, null, 2) + "\n";
    await writeFile(dest, pretty);
    if (existsSync(NAS_DIR)) {
      await writeFile(join(NAS_DIR, `PC20-${c.episode}-Chapters.json`), pretty);
    }
    ok++;
    const count = Array.isArray(parsed.chapters) ? parsed.chapters.length : 0;
    console.error(`  ep ${String(c.episode).padStart(3)}: ok  ${count} chapter(s)  ${dest}`);
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }
  console.error(`done. ok=${ok} skipped=${skipped} failed=${failed} total=${captures.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
