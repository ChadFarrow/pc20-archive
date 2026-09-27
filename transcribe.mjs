#!/usr/bin/env node
/**
 * transcribe.mjs
 *
 * Make a caption file for a PC20 episode whose transcript on
 * mp3s.nashownotes.com is missing, a "Transcript is Processing" placeholder,
 * or a copy of another episode's transcript. Output lands in captions/ as
 * PC20-{N}-Captions.srt — the server's own naming — and is served by Pages at
 * chadfarrow.github.io/pc20-archive/captions/.
 *
 * Audio comes from the server, never the NAS share: these files are public,
 * so they are made from the same MP3 a listener downloads.
 *
 * Pipeline, per episode:
 *   1. find PC20-{N}-YYYY-MM-DD-*.mp3 in the autoindex and download it
 *      (skipped when WORK_DIR already holds it at the right size)
 *   2. ffmpeg → 16 kHz mono WAV, which is what whisper.cpp reads
 *   3. whisper-cli, large-v3-turbo, Silero VAD, JSON segments
 *   4. turn the segments into caption cues and write the SRT
 *
 * Why regroup: whisper's segments run up to ~290 characters and ~25 s, too
 * long for a caption. A segment of up to 84 characters (two 42-character
 * lines) is one cue, with whisper's own times. A longer one is split at a
 * sentence end, or near the limit at a comma or other punctuation, and never
 * so that a sentence's last word or two stand alone ("project."). Segment
 * boundaries are pauses and turns of speaker, so a cue crosses one only to
 * rejoin a scrap whisper cut off mid-sentence with no pause (joinFragments).
 *
 * Times inside a split segment are shared out by character count. whisper.cpp
 * has per-token times, but they are worse: with VAD on they are left in VAD
 * time, which drifts by every silence cut so far (45 s by minute 7 of E22), and
 * with -ml 1 (which does map them) the first words of a segment often collapse
 * onto one 0.1 s slot — "It's Friday once again, time" all at 17.07 s in E22.
 *
 * Run:
 *   node transcribe.mjs 22 46 86        # episodes to transcribe
 *   node transcribe.mjs --force 22      # overwrite an existing captions/ file
 *   node transcribe.mjs --rebuild 22    # rewrite the SRT from the whisper JSON
 *                                       # already in WORK_DIR; no audio, no whisper
 *   node transcribe.mjs --nas           # copy captions/ to the NAS share, over
 *                                       # the server's placeholders there
 *
 * Needs ffmpeg and whisper-cli on PATH (brew install ffmpeg whisper.cpp) and
 * the two models — see captions/README.md. Env: WORK_DIR, WHISPER_MODEL,
 * WHISPER_VAD_MODEL, WHISPER_THREADS.
 */

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, stat, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const INDEX_URL = "https://mp3s.nashownotes.com/";
const UA = "Mozilla/5.0 pc20-archive-transcribe (+https://github.com/ChadFarrow/pc20-archive)";
const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(ROOT, "captions");
const WORK_DIR = process.env.WORK_DIR ?? join(tmpdir(), "pc20-transcribe");
const MODELS = join(homedir(), ".local/share/whisper.cpp/models");
const MODEL = process.env.WHISPER_MODEL ?? join(MODELS, "ggml-large-v3-turbo.bin");
const VAD_MODEL = process.env.WHISPER_VAD_MODEL ?? join(MODELS, "ggml-silero-v5.1.2.bin");
const THREADS = process.env.WHISPER_THREADS ?? "8";
const NAS_DIR = process.env.NAS_DIR ?? "/Volumes/pc20-archive";

// Spellings the show uses that whisper otherwise guesses at. It steers only the
// first 30 s window. A prompt can be echoed back as speech, so check the output
// for it (none of the 14 episodes in captions/ did).
const PROMPT =
  "Podcasting 2.0, with Adam Curry and Dave Jones. Podcast Index, podcastindex.org, " +
  "boostagrams, sats, Lightning, value for value, Fountain, Breez, Sphinx, Podverse, " +
  "Castamatic, podping.";

export const LINE = 42;
export const CUE_MAX = LINE * 2;
/**
 * A punctuation break is taken only if it leaves at least this much in the cue,
 * and a sentence's last words shorter than this are not left on their own.
 */
const MIN_SPLIT = 20;
/** How far past the limit to look for the end of the sentence. */
const LOOKAHEAD_WORDS = 6;

const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

/** whisper-cli -oj output → [{ text, from, to }] in ms, empty segments dropped. */
export function segmentsFromJson(json) {
  return json.transcription
    .map((s) => ({ text: s.text.trim().replace(/\s+/g, " "), from: s.offsets.from, to: s.offsets.to }))
    .filter((s) => s.text);
}

const joined = (words) => words.map((w) => w.text).join(" ");
const endsSentence = (w) => /[.?!]["')\]]?$/.test(w.text);
const endsClause = (w) => /[,;:\u2014-]["')\]]?$/.test(w.text) || endsSentence(w);

/** A segment's words, each given its share of the segment's time by character count. */
function wordsOf(seg) {
  const len = seg.text.length;
  const at = (i) => Math.round(seg.from + ((seg.to - seg.from) * i) / len);
  const words = [];
  for (const m of seg.text.matchAll(/\S+/g)) {
    words.push({ text: m[0], from: at(m.index), to: at(m.index + m[0].length) });
  }
  words.at(-1).to = seg.to;
  return words;
}

/** One segment longer than CUE_MAX → its cues. */
function splitSegment(seg) {
  const words = wordsOf(seg);
  const cues = [];
  let cur = [];

  const flush = (n = cur.length) => {
    const take = cur.slice(0, n);
    cur = cur.slice(n);
    if (take.length) cues.push({ from: take[0].from, to: take.at(-1).to, text: joined(take) });
  };

  for (let k = 0; k < words.length; k += 1) {
    const w = words[k];
    if (cur.length && joined([...cur, w]).length > CUE_MAX) {
      // Break at the last clause end that keeps the cue a useful length.
      let cut = cur.length;
      for (let i = cur.length - 1; i > 0; i -= 1) {
        if (endsClause(cur[i - 1]) && joined(cur.slice(0, i)).length >= MIN_SPLIT) {
          cut = i;
          break;
        }
      }
      // No clause end: a plain cut here would strand the sentence's last few
      // words ("project.") as a cue of their own, so split into halves instead.
      if (cut === cur.length) {
        let end = k;
        while (end < words.length - 1 && !endsSentence(words[end]) && end - k < LOOKAHEAD_WORDS) end += 1;
        const tail = words.slice(k, end + 1);
        if ((endsSentence(words[end]) || end === words.length - 1) && joined(tail).length < MIN_SPLIT) {
          const half = joined([...cur, ...tail]).length / 2;
          for (let i = 1; i < cur.length; i += 1) {
            if (joined(cur.slice(0, i)).length >= half) {
              cut = i;
              break;
            }
          }
        }
      }
      flush(cut);
    }
    cur.push(w);
    if (endsSentence(w)) flush();
  }
  flush();
  return cues;
}

/**
 * A segment slower than this over more than SLOW_MIN_MS is not speech: its span
 * is music VAD let through. E204's "Well, I'm alive." covers 53:39-57:19, the
 * whole of a song. It keeps its start and ends after a reading time.
 *
 * Repeats are left alone. They look like whisper stuck in a loop, and are not:
 * E222 has "Stable coins." 34 times running (a supercut Adam plays) and E86
 * "Right." seven times in two seconds, and a second decode with no prompt and
 * no text context heard both the same way.
 */
const SLOW_CHARS_PER_S = 5;
const SLOW_MIN_MS = 8000;
const clampSlow = (seg) => {
  const ms = seg.to - seg.from;
  if (ms <= SLOW_MIN_MS || seg.text.length / (ms / 1000) >= SLOW_CHARS_PER_S) return seg;
  return { ...seg, to: seg.from + Math.max(2000, seg.text.length * 100) };
};

/** Cues closer than this are one breath, not a pause or a change of speaker. */
const JOIN_GAP_MS = 300;

const fits = (a, b) => `${a.text} ${b.text}`.length <= CUE_MAX;
const join2 = (a, b) => ({ from: a.from, to: b.to, text: `${a.text} ${b.text}` });

/**
 * When `prev` is too full to take `c`, move the words after its last clause end
 * over instead: "…the Yensa show, Robert" + "Yensa." → "…the Yensa show," +
 * "Robert Yensa.". The split time is shared out by character count. Null when
 * no clause end leaves both cues a useful length.
 */
function shiftTail(prev, c) {
  const words = prev.text.split(" ");
  for (let k = words.length - 1; k > 0; k -= 1) {
    const head = words.slice(0, k).join(" ");
    const tail = words.slice(k).join(" ");
    if (head.length < MIN_SPLIT || `${tail} ${c.text}`.length > CUE_MAX) return null;
    if (endsClause({ text: words[k - 1] })) {
      const at = Math.round(prev.from + ((prev.to - prev.from) * (head.length + 1)) / prev.text.length);
      return [
        { from: prev.from, to: at, text: head },
        { from: at, to: c.to, text: `${tail} ${c.text}` },
      ];
    }
  }
  return null;
}

/**
 * Whisper sometimes ends a segment mid-sentence with no pause at all, leaving a
 * scrap: "…the Yensa show, Robert" / "Yensa." (E86). A cue shorter than
 * MIN_SPLIT with no gap around it joins the cue it belongs to — the one before
 * if it finishes that one's sentence, otherwise the one after.
 */
function joinFragments(cues) {
  const out = [];
  const rest = cues.slice();
  for (let i = 0; i < rest.length; i += 1) {
    const c = rest[i];
    const prev = out.at(-1);
    const next = rest[i + 1];
    if (c.text.length < MIN_SPLIT) {
      const back = prev && !endsSentence(prev) && c.from - prev.to <= JOIN_GAP_MS && fits(prev, c);
      const ahead = next && !endsSentence(c) && next.from - c.to <= JOIN_GAP_MS && fits(c, next);
      if (back && (endsSentence(c) || !ahead)) {
        out[out.length - 1] = join2(prev, c);
        continue;
      }
      if (ahead) {
        rest[i + 1] = join2(c, next);
        continue;
      }
      const shifted =
        prev && endsSentence(c) && !endsSentence(prev) && c.from - prev.to <= JOIN_GAP_MS && shiftTail(prev, c);
      if (shifted) {
        out.splice(-1, 1, ...shifted);
        continue;
      }
    }
    out.push(c);
  }
  return out;
}

/** Segments → [{ from, to, text }]. Pure. */
export function buildCues(segments) {
  const cues = segments
    .map(clampSlow)
    .flatMap((seg) => (seg.text.length <= CUE_MAX ? [seg] : splitSegment(seg)));
  // VAD's time mapping can leave a short segment ending a few ms after the next
  // one starts (five times in E46 and E86, each after a "Yeah." or "Okay.").
  // Players differ on overlapping cues, so the earlier one gives way.
  const out = joinFragments(cues);
  for (let i = 1; i < out.length; i += 1) {
    if (out[i].from < out[i - 1].to) {
      out[i - 1] = { ...out[i - 1], to: Math.max(out[i].from, out[i - 1].from + 1) };
      if (out[i].from < out[i - 1].to) out[i] = { ...out[i], from: out[i - 1].to };
    }
  }
  return out;
}

/** Wrap a cue's text onto at most two lines, balanced at a space. */
export function wrap(text) {
  if (text.length <= LINE) return text;
  let best = -1;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== " ") continue;
    if (best === -1 || Math.abs(i - text.length / 2) < Math.abs(best - text.length / 2)) best = i;
  }
  return best === -1 ? text : `${text.slice(0, best)}\n${text.slice(best + 1)}`;
}

const stamp = (ms) => {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor(ms / 60_000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
};

export function toSrt(cues) {
  return cues
    .map((c, i) => `${i + 1}\n${stamp(c.from)} --> ${stamp(c.to)}\n${wrap(c.text)}\n`)
    .join("\n");
}

/** PC20-7 is a 404 on the server and PC20-07 is not; three digits go plain. */
const captionName = (n) => `PC20-${n < 10 ? `0${n}` : n}-Captions.srt`;

async function findAudio(episode) {
  const res = await fetch(INDEX_URL, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`index: HTTP ${res.status}`);
  const html = await res.text();
  const n = episode < 10 ? `0${episode}` : String(episode);
  const names = [...html.matchAll(/href="(PC20-[^"?\/]+\.mp3)"/g)]
    .map((m) => decodeURIComponent(m[1]))
    .filter((f) => new RegExp(`^PC20-${n}-\\d{4}-\\d{2}-\\d{2}-`).test(f));
  if (names.length !== 1) throw new Error(`E${episode}: expected one mp3, found ${names.length}`);
  return names[0];
}

async function fetchAudio(filename) {
  const url = new URL(encodeURIComponent(filename), INDEX_URL);
  const dest = join(WORK_DIR, filename);
  const head = await fetch(url, { method: "HEAD", headers: { "User-Agent": UA } });
  const expected = Number(head.headers.get("content-length") ?? NaN);
  const have = await stat(dest).then((s) => s.size, () => -1);
  if (have === expected) return dest;

  const tmp = join(WORK_DIR, `.${filename}.part`);
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok || !res.body) throw new Error(`${filename}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  const got = (await stat(tmp)).size;
  if (Number.isFinite(expected) && got !== expected) {
    throw new Error(`${filename}: short read, ${got} of ${expected} bytes`);
  }
  await rename(tmp, dest);
  return dest;
}

function run(cmd, args, logFile) {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(logFile);
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(out);
    child.stderr.pipe(out);
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code} — see ${logFile}`)),
    );
  });
}

async function transcribe(episode, { force, rebuild }) {
  const target = join(OUT_DIR, captionName(episode));
  const base = join(WORK_DIR, `PC20-${episode}`);
  const started = Date.now();

  if (!rebuild) {
    if (!force && (await stat(target).catch(() => null))) {
      log(`E${episode}: ${captionName(episode)} exists, skipping (--force to redo)`);
      return;
    }
    const mp3 = await fetchAudio(await findAudio(episode));
    await run("ffmpeg", ["-v", "error", "-y", "-i", mp3, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", `${base}.wav`], `${base}.ffmpeg.log`);
    await run(
      "whisper-cli",
      [
        "-m", MODEL, "-l", "en", "-t", THREADS,
        "--vad", "-vm", VAD_MODEL,
        "--prompt", PROMPT,
        "-oj", "-of", base, "-np",
        "-f", `${base}.wav`,
      ],
      `${base}.whisper.log`,
    );
  }

  const segments = segmentsFromJson(JSON.parse(await readFile(`${base}.json`, "utf8")));
  const cues = buildCues(segments);
  const tmp = join(OUT_DIR, `.${captionName(episode)}.tmp`);
  await writeFile(tmp, toSrt(cues));
  await rename(tmp, target);
  log(`E${episode}: ${segments.length} segments, ${cues.length} cues in ${Math.round((Date.now() - started) / 1000)} s → captions/${captionName(episode)}`);
}

// Same test as sync-nas.mjs: an unmounted share is either absent or a plain
// local directory, and the latter must not be written into.
async function shareMounted() {
  try {
    const [share, vols] = await Promise.all([stat(NAS_DIR), stat("/Volumes")]);
    return share.isDirectory() && share.dev !== vols.dev;
  } catch {
    return false;
  }
}

/**
 * Copy every captions/ file onto the share under the server's name, so tools
 * that read the share's captions first (pc20-clips) get a real transcript.
 *
 * The mtime is set to now on purpose. sync-nas.mjs refetches a file when the
 * server's date for it is newer than the local mtime, so these stay until the
 * server posts a newer file — a real transcript, which should then win.
 */
async function copyToNas() {
  if (!(await shareMounted())) throw new Error(`${NAS_DIR} is not mounted — nothing copied`);
  const files = (await readdir(OUT_DIR)).filter((f) => /^PC20-\d+-Captions\.srt$/.test(f));
  const now = new Date();
  for (const f of files) {
    const tmp = join(NAS_DIR, `.${f}.sync-tmp`);
    await copyFile(join(OUT_DIR, f), tmp);
    await rename(tmp, join(NAS_DIR, f));
    await utimes(join(NAS_DIR, f), now, now);
  }
  log(`copied ${files.length} caption file(s) to ${NAS_DIR}`);
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const rebuild = args.includes("--rebuild");
  const nas = args.includes("--nas");
  const episodes = args.filter((a) => /^\d+$/.test(a)).map(Number);
  if (!episodes.length && !nas) {
    console.error("usage: node transcribe.mjs [--force | --rebuild] [--nas] <episode> [<episode> ...]");
    process.exit(2);
  }
  if (episodes.length) {
    await mkdir(WORK_DIR, { recursive: true });
    await mkdir(OUT_DIR, { recursive: true });
    log(`work dir ${WORK_DIR}`);
  }

  let failed = 0;
  for (const episode of episodes) {
    try {
      await transcribe(episode, { force, rebuild });
    } catch (err) {
      failed += 1;
      log(`E${episode}: FAILED — ${err.message}`);
    }
  }
  if (nas) await copyToNas();
  if (failed) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
