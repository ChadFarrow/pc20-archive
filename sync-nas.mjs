#!/usr/bin/env node
/**
 * sync-nas.mjs
 *
 * Mirror every PC20-* file on mp3s.nashownotes.com to the NAS share
 * (//192.168.0.81/pc20-archive, mounted at /Volumes/pc20-archive). Audio,
 * captions, chapters — every episode, not just the 1–100 the feed covers.
 *
 * A file is fetched when it is missing from the share, or when the autoindex
 * date is newer than the local mtime (a caption stub the server has since
 * replaced). After a download the local mtime is set to the autoindex date,
 * so the next run compares like with like. Nothing is ever deleted.
 *
 * Downloads land in a dot-prefixed temp file and are renamed into place only
 * after the byte count matches Content-Length, so a dropped connection never
 * leaves a truncated PC20-*.mp3 for the clip tool or the wiki to read.
 *
 * Run:
 *   node sync-nas.mjs             # sync
 *   node sync-nas.mjs --dry-run   # list what would be fetched, write nothing
 *
 * Runs unattended via launchd — see launchd/ and scripts/install-agent.sh.
 */

import { createWriteStream } from "node:fs";
import { rename, stat, unlink, utimes } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const INDEX_URL = "https://mp3s.nashownotes.com/";
const NAS_DIR = process.env.NAS_DIR ?? "/Volumes/pc20-archive";
const UA = "Mozilla/5.0 pc20-archive-nas-sync (+https://github.com/ChadFarrow/pc20-archive)";
const dryRun = process.argv.includes("--dry-run");

const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);
const mb = (n) => (n / 1_000_000).toFixed(1) + " MB";

// If the share is not mounted, /Volumes/pc20-archive is either absent or a
// plain local directory. Writing into the latter would fill the Mac's disk,
// so require a different device from /Volumes itself.
async function shareMounted() {
  try {
    const [share, vols] = await Promise.all([stat(NAS_DIR), stat("/Volumes")]);
    return share.isDirectory() && share.dev !== vols.dev;
  } catch {
    return false;
  }
}

// nginx autoindex rows: <a href="PC20-...">…</a></td><td class="size">…</td><td class="date">2026-May-15 19:31</td>
// The date is UTC: it matches the server's Last-Modified header.
async function listRemote() {
  const res = await fetch(INDEX_URL, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`index: HTTP ${res.status}`);
  const html = await res.text();
  const out = new Map();
  for (const m of html.matchAll(/href="(PC20-[^"?\/]+)"[\s\S]*?class="date">([^<]+)</g)) {
    const filename = decodeURIComponent(m[1]);
    const date = new Date(`${m[2].replace(/-/g, " ")} UTC`);
    if (!out.has(filename) && !isNaN(+date)) out.set(filename, date);
  }
  if (out.size === 0) throw new Error("index: no PC20-* files parsed — has the page layout changed?");
  return out;
}

async function download(filename, date) {
  const dest = join(NAS_DIR, filename);
  const tmp = join(NAS_DIR, `.${filename}.sync-tmp`);
  const res = await fetch(new URL(encodeURIComponent(filename), INDEX_URL), {
    headers: { "User-Agent": UA },
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const expected = Number(res.headers.get("content-length") ?? NaN);
  try {
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
    const got = (await stat(tmp)).size;
    if (Number.isFinite(expected) && got !== expected) {
      throw new Error(`short read: ${got} of ${expected} bytes`);
    }
    await rename(tmp, dest);
    // After the rename, not before: the SMB share resets mtime on rename.
    await utimes(dest, date, date);
    return got;
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

async function main() {
  if (!(await shareMounted())) {
    log(`${NAS_DIR} is not a mounted share — nothing to do`);
    return 0;
  }

  const remote = await listRemote();
  const todo = [];
  for (const [filename, date] of remote) {
    const local = await stat(join(NAS_DIR, filename)).catch(() => null);
    if (!local) todo.push({ filename, date, why: "new" });
    else if (+date > +local.mtime) todo.push({ filename, date, why: "updated" });
  }
  // Oldest first, so an interrupted run leaves a gap at the end, not the middle.
  todo.sort((a, b) => a.date - b.date);

  log(`${remote.size} PC20-* files on server, ${todo.length} to fetch${dryRun ? " (dry run)" : ""}`);

  let failed = 0;
  for (const { filename, date, why } of todo) {
    if (dryRun) {
      log(`  would fetch  ${filename}  (${why})`);
      continue;
    }
    try {
      const size = await download(filename, date);
      log(`  ok    ${filename}  (${why}, ${mb(size)})`);
    } catch (e) {
      failed++;
      log(`  FAIL  ${filename}: ${e?.message ?? e}`);
    }
  }

  if (todo.length && !dryRun) log(`done: ${todo.length - failed} fetched, ${failed} failed`);
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    log(`error: ${e?.message ?? e}`);
    process.exit(1);
  }
);
