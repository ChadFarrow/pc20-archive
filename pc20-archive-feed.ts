/**
 * pc20-archive-feed.ts
 *
 * Builds a Podcasting 2.0 back-catalog RSS feed by:
 *   1) Scraping https://mp3s.nashownotes.com/ for ALL PC20-* files
 *      (audio, captions, transcripts, chapters JSON, anything else)
 *   2) Bundling companion files with their episode by episode number
 *   3) Pulling historical pc20rss.xml snapshots from the Wayback Machine
 *   4) Matching audio files to historical <item>s for title/pubDate/show notes
 *   5) Emitting RSS 2.0 with itunes:, podcast:, content: namespaces — including
 *      <podcast:transcript> and <podcast:chapters> tags where companions exist
 *
 * Run:
 *   npm i -D tsx fast-xml-parser
 *   npx tsx pc20-archive-feed.ts pc20-archive.xml
 *
 * Env:
 *   MIN_EP=1            // include episodes >= this
 *   MAX_EP=67           // include episodes <= this (active feed picks up at 68)
 *   MAX_SNAPS=25        // cap on Wayback snapshots to fetch
 *   VERIFY_LENGTH=1     // HEAD each mp3 to populate enclosure length
 *   DUMP_FILES=1        // print every matched PC20 file before building feed
 *   DOWNLOAD_DIR=./pc20 // download mp3s here (skips already-downloaded files)
 *   DOWNLOAD_ALL=1      // download all PC20 files (audio + companions), not just mp3s
 */

import { writeFileSync, createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { XMLParser } from "fast-xml-parser";

const INDEX_URL = "https://mp3s.nashownotes.com/";
const FEED_URL = "https://mp3s.nashownotes.com/pc20rss.xml";
const CDX = "https://web.archive.org/cdx/search/cdx";
const ART_URL = "https://noagendaassets.com/enc/1601061118.678_pciavatar.jpg";

// Any file whose name starts with PC20-<ep>...
const PC20_ANY_RE = /^PC20-(\d{1,4})\b/i;
// The audio file (encodes pubDate in the name)
const PC20_MP3_RE = /^PC20-(\d{1,4})-(\d{4})-(\d{2})-(\d{2})[^"]*?\.mp3$/i;

type Kind = "audio" | "transcript" | "captions" | "chapters" | "other";

type Pc20File = {
  filename: string;
  url: string;
  episode: number;
  kind: Kind;
  ext: string;
  mimeType: string;
  date?: string;       // only set for audio (from filename)
  mtime?: Date;        // mod time parsed from the nginx autoindex
  length?: number;     // populated via HEAD if VERIFY_LENGTH=1
};

type FeedItem = {
  title?: string;
  pubDate?: string;
  description?: string;
  showNotes?: string;  // content:encoded if present
  guid?: string;
  duration?: string;
  enclosureUrl?: string;
  filename?: string;
};

type Bundle = {
  episode: number;
  audio?: Pc20File;
  transcripts: Pc20File[];   // .srt / .vtt / transcript .json
  chapters: Pc20File[];      // chapters .json
  other: Pc20File[];
};

// ---------- 1) classify a PC20-* filename ----------
function classify(filename: string): { kind: Kind; ext: string; mimeType: string } {
  const lower = filename.toLowerCase();
  const ext = lower.split(".").pop() ?? "";
  if (lower.endsWith(".mp3")) return { kind: "audio", ext, mimeType: "audio/mpeg" };
  if (lower.endsWith(".srt")) {
    const captions = /captions?/i.test(filename);
    return { kind: captions ? "captions" : "transcript", ext, mimeType: "application/srt" };
  }
  if (lower.endsWith(".vtt")) return { kind: "transcript", ext, mimeType: "text/vtt" };
  if (lower.endsWith(".json")) {
    if (/chapter/i.test(filename)) return { kind: "chapters", ext, mimeType: "application/json+chapters" };
    if (/transcript/i.test(filename)) return { kind: "transcript", ext, mimeType: "application/json" };
    return { kind: "other", ext, mimeType: "application/json" };
  }
  if (lower.endsWith(".txt")) return { kind: "transcript", ext, mimeType: "text/plain" };
  if (lower.endsWith(".html") || lower.endsWith(".htm"))
    return { kind: "transcript", ext, mimeType: "text/html" };
  return { kind: "other", ext, mimeType: "application/octet-stream" };
}

// Parse the mod date that follows each <a href> in the nginx autoindex.
function extractMtime(segment: string): Date | undefined {
  let m = segment.match(/(\d{4})-([A-Za-z]{3})-(\d{2})\s+(\d{2}):(\d{2})/);
  if (m) {
    const d = new Date(`${m[3]} ${m[2]} ${m[1]} ${m[4]}:${m[5]} UTC`);
    if (!isNaN(+d)) return d;
  }
  m = segment.match(/(\d{2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}):(\d{2})/);
  if (m) {
    const d = new Date(`${m[1]} ${m[2]} ${m[3]} ${m[4]}:${m[5]} UTC`);
    if (!isNaN(+d)) return d;
  }
  m = segment.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (m) {
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}Z`);
    if (!isNaN(+d)) return d;
  }
  return undefined;
}

// ---------- 2) scrape the nginx autoindex ----------
async function scrapeIndex(): Promise<Pc20File[]> {
  const html = await fetch(INDEX_URL).then((r) => r.text());
  const linkRe = /href="([^"?][^"]*)"/g;
  const links = [...html.matchAll(linkRe)];
  const out: Pc20File[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < links.length; i++) {
    const filename = decodeURIComponent(links[i][1]);
    if (seen.has(filename)) continue;
    const any = filename.match(PC20_ANY_RE);
    if (!any) continue;
    seen.add(filename);
    const episode = parseInt(any[1], 10);
    const { kind, ext, mimeType } = classify(filename);
    const segStart = links[i].index! + links[i][0].length;
    const segEnd = links[i + 1]?.index ?? html.length;
    const mtime = extractMtime(html.slice(segStart, segEnd));
    const file: Pc20File = {
      filename,
      url: new URL(filename, INDEX_URL).toString(),
      episode,
      kind,
      ext,
      mimeType,
      mtime,
    };
    const mp3 = filename.match(PC20_MP3_RE);
    if (mp3) file.date = `${mp3[2]}-${mp3[3]}-${mp3[4]}`;
    out.push(file);
  }
  return out;
}

function bundle(files: Pc20File[]): Map<number, Bundle> {
  const map = new Map<number, Bundle>();
  for (const f of files) {
    let b = map.get(f.episode);
    if (!b) {
      b = { episode: f.episode, transcripts: [], chapters: [], other: [] };
      map.set(f.episode, b);
    }
    if (f.kind === "audio") b.audio = f;
    else if (f.kind === "transcript" || f.kind === "captions") b.transcripts.push(f);
    else if (f.kind === "chapters") b.chapters.push(f);
    else b.other.push(f);
  }
  return map;
}

// ---------- 3) Wayback snapshots of pc20rss.xml ----------
async function listSnapshots(maxSnaps: number): Promise<string[]> {
  const url =
    `${CDX}?url=${encodeURIComponent(FEED_URL)}&output=json` +
    `&fl=timestamp,statuscode,digest&filter=statuscode:200&collapse=digest`;
  const rows = (await fetch(url).then((r) => r.json())) as string[][];
  rows.shift();
  rows.sort((a, b) => a[0].localeCompare(b[0]));
  return rows.slice(0, maxSnaps).map(([ts]) => `https://web.archive.org/web/${ts}id_/${FEED_URL}`);
}

function filenameFromUrl(u: string): string | undefined {
  try {
    return decodeURIComponent(new URL(u).pathname.split("/").pop() ?? "");
  } catch {
    return undefined;
  }
}

async function parseSnapshot(url: string): Promise<FeedItem[]> {
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const xml = await res.text();
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      textNodeName: "#text",
      isArray: (n) => n === "item",
      processEntities: { enabled: true, maxTotalExpansions: 1_000_000, maxExpandedLength: 10_000_000 },
    });
    const j = parser.parse(xml);
    const items: any[] = j?.rss?.channel?.item ?? [];
    return items.map((it) => {
      const enclosureUrl: string | undefined = it?.enclosure?.["@_url"];
      const guid = typeof it.guid === "object" ? it.guid?.["#text"] : it.guid;
      return {
        title: typeof it.title === "string" ? it.title : it?.title?.["#text"],
        pubDate: it.pubDate,
        description:
          typeof it.description === "string" ? it.description : it?.description?.["#text"],
        showNotes:
          typeof it["content:encoded"] === "string"
            ? it["content:encoded"]
            : it?.["content:encoded"]?.["#text"],
        guid,
        duration: it["itunes:duration"],
        enclosureUrl,
        filename: enclosureUrl ? filenameFromUrl(enclosureUrl) : undefined,
      } as FeedItem;
    });
  } catch {
    return [];
  }
}

async function buildMetaMap(maxSnaps: number): Promise<Map<string, FeedItem>> {
  const snaps = await listSnapshots(maxSnaps);
  const byFile = new Map<string, FeedItem>();
  for (const url of snaps) {
    const items = await parseSnapshot(url);
    for (const it of items) {
      if (!it.filename) continue;
      if (!byFile.has(it.filename)) byFile.set(it.filename, it);
    }
    process.stderr.write(".");
  }
  process.stderr.write("\n");
  return byFile;
}

// ---------- 4) optional HEAD for enclosure length ----------
async function fillLengths(files: Pc20File[], concurrency = 6) {
  let i = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (i < files.length) {
        const idx = i++;
        try {
          const r = await fetch(files[idx].url, { method: "HEAD" });
          const len = r.headers.get("content-length");
          if (len) files[idx].length = parseInt(len, 10);
        } catch {
          /* ignore */
        }
      }
    })
  );
}

// ---------- 4b) download files to disk ----------
async function downloadFiles(files: Pc20File[], dir: string, concurrency = 3) {
  await mkdir(dir, { recursive: true });
  const total = files.length;
  let i = 0;
  let done = 0;
  const fmt = (n: number) => (n / 1_000_000).toFixed(1) + " MB";
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (i < files.length) {
        const idx = i++;
        const f = files[idx];
        const dest = join(dir, f.filename);
        const tag = `[${String(++done).padStart(3)}/${total}]`;
        try {
          const localSize = await stat(dest).then((s) => s.size).catch(() => null);
          if (localSize !== null) {
            const head = await fetch(f.url, { method: "HEAD" });
            const remote = parseInt(head.headers.get("content-length") ?? "0", 10);
            if (remote > 0 && localSize === remote) {
              console.error(`  ${tag} skip   ${f.filename}  (${fmt(localSize)})`);
              continue;
            }
          }
          const res = await fetch(f.url);
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
          await pipeline(Readable.fromWeb(res.body as any), createWriteStream(dest));
          const sz = (await stat(dest)).size;
          console.error(`  ${tag} ok     ${f.filename}  (${fmt(sz)})`);
        } catch (e: any) {
          console.error(`  ${tag} FAIL   ${f.filename}: ${e?.message ?? e}`);
        }
      }
    })
  );
}

// ---------- 5) build the feed ----------
const xmlEsc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const pubDateFromYmd = (ymd: string) => new Date(`${ymd}T14:00:00Z`).toUTCString();

function transcriptLines(b: Bundle): string {
  const tags: string[] = [];
  for (const f of b.transcripts) {
    const rel = f.kind === "captions" ? ` rel="captions"` : "";
    tags.push(
      `      <podcast:transcript url="${xmlEsc(f.url)}" type="${f.mimeType}"${rel}/>`
    );
  }
  return tags.join("\n");
}

function chaptersLine(b: Bundle): string {
  if (!b.chapters.length) return "";
  const sorted = [...b.chapters].sort((a, c) => {
    const at = a.mtime?.getTime() ?? 0;
    const ct = c.mtime?.getTime() ?? 0;
    return ct - at;
  });
  const f = sorted[0];
  return `      <podcast:chapters url="${xmlEsc(f.url)}" type="${f.mimeType}"/>`;
}

function buildFeed(bundles: Bundle[], meta: Map<string, FeedItem>, range: { min: number; max: number }) {
  bundles.sort((a, b) => a.episode - b.episode);
  const picked = bundles.filter((b) => b.episode >= range.min && b.episode <= range.max && b.audio);

  const itemsXml = picked
    .map((b) => {
      const audio = b.audio!;
      const m = meta.get(audio.filename) ?? {};
      const title = m.title ?? `Episode ${b.episode}`;
      const pubDate = m.pubDate || (audio.date ? pubDateFromYmd(audio.date) : new Date().toUTCString());
      const guid = m.guid || audio.url;
      const desc = m.description ?? `Podcasting 2.0 Episode ${b.episode}`;
      const notes = m.showNotes ?? desc;
      const len = audio.length ?? 0;
      const duration = m.duration
        ? `\n      <itunes:duration>${xmlEsc(String(m.duration))}</itunes:duration>`
        : "";
      const transcripts = transcriptLines(b);
      const chapters = chaptersLine(b);
      const extras = [transcripts, chapters].filter(Boolean).join("\n");
      const extrasBlock = extras ? `\n${extras}` : "";
      return `    <item>
      <title>${xmlEsc(title)}</title>
      <description><![CDATA[${notes}]]></description>
      <pubDate>${pubDate}</pubDate>
      <guid isPermaLink="false">${xmlEsc(guid)}</guid>
      <enclosure url="${xmlEsc(audio.url)}" length="${len}" type="audio/mpeg"/>
      <itunes:image href="${xmlEsc(ART_URL)}"/>
      <itunes:episode>${b.episode}</itunes:episode>
      <itunes:episodeType>full</itunes:episodeType>${duration}${extrasBlock}
    </item>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
  xmlns:podcast="https://podcastindex.org/namespace/1.0"
  xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Podcasting 2.0 — Archive (Eps ${range.min}–${range.max})</title>
    <link>https://podcastindex.org/podcast/920666</link>
    <description>Back-catalog feed for the Podcasting 2.0 podcast. Audio hosted by Adam Curry at mp3s.nashownotes.com. Item metadata reconstructed from Wayback Machine snapshots of the original RSS feed; transcripts and chapters pulled from companion files in the same directory.</description>
    <language>en-us</language>
    <image>
      <url>${ART_URL}</url>
      <title>Podcasting 2.0 — Archive (Eps ${range.min}–${range.max})</title>
      <link>https://podcastindex.org/podcast/920666</link>
    </image>
    <itunes:image href="${ART_URL}"/>
    <itunes:author>Adam Curry &amp; Dave Jones</itunes:author>
    <itunes:explicit>false</itunes:explicit>
    <itunes:category text="Technology"/>
    <podcast:guid>pc20-archive-${range.min}-${range.max}</podcast:guid>
    <podcast:medium>podcast</podcast:medium>
    <podcast:remoteItem feedGuid="917393e3-1b1e-5cef-ace4-edaa54e1f810" feedUrl="${FEED_URL}"/>
${itemsXml}
  </channel>
</rss>
`;
}

// ---------- main ----------
async function main() {
  const out = process.argv[2] ?? "pc20-archive.xml";
  const min = Number(process.env.MIN_EP ?? 1);
  const max = Number(process.env.MAX_EP ?? 67);
  const maxSnaps = Number(process.env.MAX_SNAPS ?? 25);

  console.error(`[1/4] scraping ${INDEX_URL}`);
  const files = await scrapeIndex();
  const byKind = files.reduce<Record<Kind, number>>(
    (acc, f) => ((acc[f.kind] = (acc[f.kind] ?? 0) + 1), acc),
    { audio: 0, transcript: 0, captions: 0, chapters: 0, other: 0 }
  );
  console.error(
    `      matched ${files.length} PC20-* files — ` +
    `${byKind.audio} audio, ${byKind.transcript} transcripts, ${byKind.captions} captions, ` +
      `${byKind.chapters} chapter files, ${byKind.other} other`
  );

  if (process.env.DUMP_FILES === "1") {
    for (const f of files.sort((a, b) => a.episode - b.episode || a.filename.localeCompare(b.filename))) {
      const mt = f.mtime ? f.mtime.toISOString().slice(0, 16).replace("T", " ") : "                ";
      console.error(`      ep ${String(f.episode).padStart(3)}  ${mt}  ${f.kind.padEnd(10)}  ${f.filename}`);
    }
  }

  const bundles = [...bundle(files).values()];
  const inRange = bundles.filter((b) => b.episode >= min && b.episode <= max);
  const missingAudio = inRange.filter((b) => !b.audio).map((b) => b.episode);
  if (missingAudio.length) {
    console.error(`      ⚠ ${missingAudio.length} episode(s) have companion files but no mp3: ${missingAudio.join(", ")}`);
  }

  if (process.env.DOWNLOAD_DIR) {
    const dir = process.env.DOWNLOAD_DIR;
    const all = process.env.DOWNLOAD_ALL === "1";
    const toDl = files
      .filter((f) => f.episode >= min && f.episode <= max)
      .filter((f) => all || f.kind === "audio")
      .sort((a, b) => a.episode - b.episode);
    console.error(`[*]   downloading ${toDl.length} file(s) to ${dir}${all ? " (audio + companions)" : " (audio only)"}`);
    await downloadFiles(toDl, dir);
  }

  console.error(`[2/4] pulling up to ${maxSnaps} Wayback snapshots of pc20rss.xml`);
  const meta = await buildMetaMap(maxSnaps);
  console.error(`      collected metadata for ${meta.size} items`);

  if (process.env.VERIFY_LENGTH === "1") {
    console.error(`[3/4] HEAD requests to populate enclosure lengths`);
    await fillLengths(files.filter((f) => f.kind === "audio"));
  } else {
    console.error(`[3/4] skipping length verification (set VERIFY_LENGTH=1 to enable)`);
  }

  console.error(`[4/4] building feed for episodes ${min}–${max}`);
  const xml = buildFeed(bundles, meta, { min, max });
  writeFileSync(out, xml);

  const included = inRange.filter((b) => b.audio).length;
  const matched = inRange.filter((b) => b.audio && meta.has(b.audio.filename)).length;
  const withTranscripts = inRange.filter((b) => b.audio && b.transcripts.length).length;
  const withChapters = inRange.filter((b) => b.audio && b.chapters.length).length;
  console.error(
    `✓ wrote ${out} — ${included} items, ${matched} with full metadata, ` +
      `${withTranscripts} with transcripts, ${withChapters} with chapters`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
