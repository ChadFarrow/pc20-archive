# captions/

Machine transcripts for the 14 *Podcasting 2.0* episodes that have no usable
transcript on `mp3s.nashownotes.com`. Served by GitHub Pages at
`https://chadfarrow.github.io/pc20-archive/captions/PC20-{N}-Captions.srt` — the
server's own file names, so a tool that reads the server's captions can read these
the same way.

| Episodes | Why the server's file is not usable |
|---|---|
| 22, 46, 86, 204, 222, 226, 228, 256 | A one-cue "Transcript is Processing" placeholder |
| 50, 51 | One transcript, byte-identical under both numbers. It is E51's |
| 248, 249 | One transcript, byte-identical under both numbers. It is E248's |
| 10, 244 | No transcript was ever published |

For the duplicated pairs, the owner was found by matching the server's text against
these transcripts of each episode's audio. Of the server file's four-word sequences,
65.8% occur in E51 here and 2.7% in E50; 80.6% occur in E248 here and 2.7% in E249.
The spoken intro agrees both times ("August 20 2021, Episode 51"; "January 23rd,
2026" is E248's air date). So the server never had a transcript of E50 or E249.
Both episodes of each pair are transcribed here anyway, so every file in this
directory was made the same way.

## How they were made

`transcribe.mjs` at the repo root, from the MP3 on `mp3s.nashownotes.com` (never the
NAS copy), on 2026-09-26:

- whisper.cpp 1.9.4 (`brew install whisper.cpp`), Metal, on an Apple M4
- model `ggml-large-v3-turbo.bin`, SHA-1 `4af2b29d7ec73d781377bfd1758ca957a807e941`,
  from `huggingface.co/ggerganov/whisper.cpp`
- Silero VAD `ggml-silero-v5.1.2.bin`, from `huggingface.co/ggml-org/whisper-vad`
- English, a short vocabulary prompt (show and app names), everything else default

Both models are expected in `~/.local/share/whisper.cpp/models/`, or set
`WHISPER_MODEL` / `WHISPER_VAD_MODEL`. About 15× real time: a two-hour episode takes
eight minutes.

Cues are two lines of at most 42 characters. A whisper segment that fits is one cue
with whisper's times; a longer one is split at a sentence or clause end, with times
shared out by character count inside the segment. `transcribe.mjs` explains why.

## Limits

- No speaker labels — the server's captions have none either.
- Songs played on the show are mostly left out: VAD treats sung music as non-speech
  (E204's Abel James song at 53:05 is one cue). Spoken supercuts are kept word for
  word — E222's "Stable coins." runs 34 cues, and that is the audio.
- Names the model has not heard can be misspelled.
- A file here replaces the server's captions for its episode in `pc20-archive.xml`
  (`patch-transcripts.ts`, and `pc20-archive-feed.ts` on a full build). If the
  server later publishes a real transcript for one of these episodes, delete the
  file here and point that item's tag back at the server by hand — the patcher
  only adds and redirects, it never reverts.

## Regenerate

```bash
node transcribe.mjs 22 46 86        # skips episodes already in captions/
node transcribe.mjs --force 22      # redo one
npx tsx patch-transcripts.ts pc20-archive.xml
```
