/**
 * user-agent.mjs
 *
 * The one User-Agent that every request from this repo sends:
 *   pc20-archive/<package.json version> (+https://chadfarrow.github.io/pc20-archive/)
 *
 * Plain Node, no dependencies: sync-nas.mjs imports it from launchd with no
 * `npm install`. package.json is found next to this file, not in the working
 * directory, because launchd does not start in the repo.
 *
 * Until 2026-11-27 each script sent its own browser-like
 * "Mozilla/5.0 pc20-archive-<script> (+github)" string, and the feed builder
 * sent Node's default "node". On 2026-11-27 mp3s.nashownotes.com (index, MP3
 * range GET, HEAD, captions) and web.archive.org (CDX, id_ snapshot) answered
 * this name exactly as they answered the old ones.
 */

import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export const APP_NAME = "pc20-archive";
export const APP_URL = "https://chadfarrow.github.io/pc20-archive/";
export const USER_AGENT = `${APP_NAME}/${version} (+${APP_URL})`;
