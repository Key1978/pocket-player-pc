'use strict';
// Pocket Player download manager: downloads files from links with progress, cancel and retry.
// Kept separate from Electron so it can be tested with plain Node.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) PocketPlayer/1.0';
const MEDIA_EXT = ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'oga', 'opus', 'weba', 'aif', 'aiff', 'wma',
  'mp4', 'm4v', 'mov', 'webm', 'mkv', '3gp', 'ogv', 'avi', 'wmv'];
const TYPE_EXT = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/flac': 'flac',
  'audio/x-flac': 'flac', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/ogg': 'ogg', 'audio/opus': 'opus',
  'audio/webm': 'weba', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv',
  'video/ogg': 'ogv', 'application/pdf': 'pdf', 'application/zip': 'zip', 'image/jpeg': 'jpg', 'image/png': 'png'
};
// Streaming services that don't allow downloading. Pocket Player doesn't try to get around that.
const BLOCKED = [
  [/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i, 'YouTube'],
  [/(^|\.)spotify\.com$/i, 'Spotify'],
  [/(^|\.)music\.apple\.com$/i, 'Apple Music'],
  [/(^|\.)soundcloud\.com$/i, 'SoundCloud'],
  [/(^|\.)tiktok\.com$/i, 'TikTok'],
  [/(^|\.)instagram\.com$/i, 'Instagram'],
  [/(^|\.)(facebook\.com|fb\.watch)$/i, 'Facebook'],
  [/(^|\.)(twitter\.com|x\.com)$/i, 'X (Twitter)'],
  [/(^|\.)deezer\.com$/i, 'Deezer'],
  [/(^|\.)tidal\.com$/i, 'Tidal'],
  [/(^|\.)netflix\.com$/i, 'Netflix'],
  [/(^|\.)twitch\.tv$/i, 'Twitch'],
  [/(^|\.)vimeo\.com$/i, 'Vimeo'],
  [/(^|\.)amazon\.[a-z.]+$/i, 'Amazon'],
  [/(^|\.)bandcamp\.com$/i, 'Bandcamp']
];

const extOf = (n) => (String(n).split(/[?#]/)[0].split('.').pop() || '').toLowerCase();
const isMediaName = (n) => MEDIA_EXT.includes(extOf(n));

function blockedSite(u) {
  try {
    const host = new URL(u).hostname;
    for (const [re, name] of BLOCKED) if (re.test(host)) return name;
  } catch (e) { /* not a URL */ }
  return null;
}

/* Turns share links into direct download links where the service allows it. */
function normalizeLink(raw) {
  let s = String(raw || '').trim();
  if (!s) return { error: 'Paste a link first.' };
  if (!/^[a-z]+:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch (e) { return { error: 'That doesn’t look like a web link.' }; }
  if (!/^https?:$/.test(u.protocol)) return { error: 'Only http and https links can be downloaded.' };
  const host = u.hostname.toLowerCase();
  if (/(^|\.)dropbox\.com$/.test(host)) {
    u.searchParams.delete('dl'); u.searchParams.set('dl', '1');
    return { url: u.toString(), via: 'Dropbox' };
  }
  if (host === 'drive.google.com' || host === 'docs.google.com') {
    const m = u.pathname.match(/\/file\/d\/([\w-]{10,})/) || u.pathname.match(/\/d\/([\w-]{10,})/);
    const id = (m && m[1]) || u.searchParams.get('id');
    if (id) return { url: `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`, via: 'Google Drive' };
  }
  if (host === 'github.com') {
    const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
    if (m) return { url: `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`, via: 'GitHub' };
  }
  return { url: u.toString() };
}

function decodeName(n) {
  try { return decodeURIComponent(n); } catch (e) { return n; }
}
function safeName(n) {
  let s = String(n || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim();
  s = s.replace(/^\.+/, '').slice(0, 150).trim();
  return s || 'download';
}
/* Picks a file name from the server's headers, the link, and the file type. */
function fileNameFrom(headers, url, wanted) {
  let name = wanted || '';
  const cd = headers.get('content-disposition') || '';
  if (!name) {
    const star = cd.match(/filename\*\s*=\s*(?:UTF-8|utf-8)?''([^;]+)/);
    const plain = cd.match(/filename\s*=\s*"?([^";]+)"?/i);
    if (star) name = decodeName(star[1].trim());
    else if (plain) name = plain[1].trim();
  }
  if (!name) {
    try { name = decodeName(new URL(url).pathname.split('/').filter(Boolean).pop() || ''); } catch (e) { name = ''; }
  }
  const type = (headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const want = TYPE_EXT[type];
  if (!name) name = 'download';
  if (want && !/\.[a-z0-9]{2,4}$/i.test(name)) name += '.' + want;
  return safeName(name);
}

async function uniquePath(dir, name) {
  const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const p = path.join(dir, i === 1 ? name : `${base} (${i})${ext}`);
    try { await fsp.access(p); } catch (e) { try { await fsp.access(p + '.part'); } catch (e2) { return p; } }
  }
  return path.join(dir, `${base} ${Date.now()}${ext}`);
}

/* Finds audio and video files linked from a web page. */
function extractMedia(html, baseUrl) {
  const out = [], seen = new Set();
  const add = (raw) => {
    if (!raw) return;
    const v = raw.replace(/&amp;/g, '&').trim();
    if (!v || /^(data|blob|javascript):/i.test(v)) return;
    let abs;
    try { abs = new URL(v, baseUrl).toString(); } catch (e) { return; }
    if (!/^https?:/i.test(abs) || seen.has(abs)) return;
    seen.add(abs);
    let name = '';
    try { name = decodeName(new URL(abs).pathname.split('/').filter(Boolean).pop() || ''); } catch (e) { name = abs; }
    out.push({ url: abs, name: name || abs });
  };
  const text = String(html || '');
  let m;
  const srcRe = /<(?:audio|video|source)\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;
  while ((m = srcRe.exec(text))) add(m[1]);
  const metaRe = /<meta\b[^>]*?(?:property|name)\s*=\s*["'](?:og:audio|og:video|og:audio:url|og:video:url|twitter:player:stream)["'][^>]*?content\s*=\s*["']([^"']+)["']/gi;
  while ((m = metaRe.exec(text))) add(m[1]);
  const meta2 = /<meta\b[^>]*?content\s*=\s*["']([^"']+)["'][^>]*?(?:property|name)\s*=\s*["'](?:og:audio|og:video|og:audio:url|og:video:url)["']/gi;
  while ((m = meta2.exec(text))) add(m[1]);
  const hrefRe = /\bhref\s*=\s*["']([^"']+)["']/gi;
  while ((m = hrefRe.exec(text))) if (isMediaName(m[1])) add(m[1]);
  const encRe = /<enclosure\b[^>]*?\burl\s*=\s*["']([^"']+)["']/gi;
  while ((m = encRe.exec(text))) add(m[1]);
  return out.slice(0, 60);
}

/* Looks at a link before downloading: is it a file, a web page with media on it, or a blocked site? */
async function inspect(fetchFn, raw) {
  const norm = normalizeLink(raw);
  if (norm.error) return { type: 'error', error: norm.error };
  const site = blockedSite(norm.url);
  if (site) {
    return { type: 'blocked', site, error: `Pocket Player can’t download from ${site}. ${site} doesn’t allow downloads, so only links that go straight to a file work, like a link ending in .mp3 or .mp4.` };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let r;
  try {
    r = await fetchFn(norm.url, { headers: { 'User-Agent': UA }, signal: ctrl.signal, redirect: 'follow' });
  } catch (e) {
    clearTimeout(timer);
    return { type: 'error', error: 'Couldn’t reach that link. Check it’s typed correctly and you’re online.' };
  }
  clearTimeout(timer);
  const finalUrl = r.url || norm.url;
  if (!r.ok) { try { ctrl.abort(); } catch (e) { /* ignore */ } return { type: 'error', error: `The website said no (error ${r.status}). The link might be private or expired.` }; }
  const type = (r.headers.get('content-type') || '').toLowerCase();
  if (/text\/html|application\/xhtml/.test(type)) {
    let html = '';
    try {
      const reader = r.body.getReader(); let got = 0; const parts = [];
      while (got < 3e6) { const { done, value } = await reader.read(); if (done) break; parts.push(Buffer.from(value)); got += value.length; }
      try { reader.cancel(); } catch (e) { /* ignore */ }
      html = Buffer.concat(parts).toString('utf8');
    } catch (e) { html = ''; }
    const media = extractMedia(html, finalUrl);
    const title = (html.match(/<title[^>]*>([^<]{1,200})<\/title>/i) || [])[1] || '';
    if (!media.length) return { type: 'page', media: [], title: title.trim(), error: 'That link opens a web page, and no audio or video files were found on it.' };
    return { type: 'page', media, title: title.trim() };
  }
  if (/rss|atom|application\/xml|text\/xml/.test(type)) {
    try { ctrl.abort(); } catch (e) { /* ignore */ }
    return { type: 'feed', url: finalUrl };
  }
  const size = Number(r.headers.get('content-length')) || 0;
  const name = fileNameFrom(r.headers, finalUrl, '');
  try { ctrl.abort(); } catch (e) { /* ignore */ }
  return { type: 'file', url: norm.url, name, size, mime: type.split(';')[0], media: isMediaName(name) || /^(audio|video)\//.test(type), via: norm.via || '' };
}

class DownloadManager {
  constructor({ fetch, dirFor, onUpdate, onDone, maxActive }) {
    this.fetch = fetch; this.dirFor = dirFor; this.onUpdate = onUpdate || (() => {}); this.onDone = onDone || (() => {});
    this.maxActive = maxActive || 3; this.items = new Map(); this.seq = 0;
  }
  list() { return [...this.items.values()].map((it) => this.pub(it)); }
  pub(it) {
    const { ctrl, ...rest } = it;
    return rest;
  }
  add({ url, name, subdir }) {
    const norm = normalizeLink(url);
    if (norm.error) throw new Error(norm.error);
    const site = blockedSite(norm.url);
    if (site) throw new Error(`Pocket Player can’t download from ${site}.`);
    const it = { id: 'd' + (++this.seq) + '-' + Date.now().toString(36), url: norm.url, source: String(url), wanted: name || '', subdir: subdir || '',
      name: name || '', file: '', received: 0, total: 0, speed: 0, state: 'queued', error: '', media: false, started: Date.now() };
    this.items.set(it.id, it);
    this.emit(it, true); this.pump();
    return this.pub(it);
  }
  emit(it, force) {
    const now = Date.now();
    if (!force && now - (it._last || 0) < 250) return;
    it._last = now;
    this.onUpdate(this.pub(it));
  }
  pump() {
    const active = [...this.items.values()].filter((x) => x.state === 'downloading').length;
    const next = [...this.items.values()].find((x) => x.state === 'queued');
    if (next && active < this.maxActive) { this.run(next); this.pump(); }
  }
  cancel(id) {
    const it = this.items.get(id); if (!it) return;
    if (it.state === 'queued') { it.state = 'cancelled'; this.emit(it, true); return; }
    if (it.state === 'downloading' && it.ctrl) { it.cancelled = true; it.ctrl.abort(); }
  }
  retry(id) {
    const it = this.items.get(id); if (!it || !/failed|cancelled/.test(it.state)) return;
    Object.assign(it, { state: 'queued', received: 0, total: 0, error: '', cancelled: false, speed: 0 });
    this.emit(it, true); this.pump();
  }
  clearFinished() { for (const [k, v] of this.items) if (/done|failed|cancelled/.test(v.state)) this.items.delete(k); }
  async run(it) {
    it.state = 'downloading'; it.ctrl = new AbortController(); it.received = 0; this.emit(it, true);
    let part = '', out = null;
    try {
      const r = await this.fetch(it.url, { headers: { 'User-Agent': UA }, signal: it.ctrl.signal, redirect: 'follow' });
      if (!r.ok) throw new Error(`The website said no (error ${r.status}).`);
      const type = (r.headers.get('content-type') || '').toLowerCase();
      if (/text\/html/.test(type)) throw new Error('That link opens a web page, not a file.');
      it.total = Number(r.headers.get('content-length')) || 0;
      const name = fileNameFrom(r.headers, r.url || it.url, it.wanted ? safeName(it.wanted) : '');
      it.media = isMediaName(name) || /^(audio|video)\//.test(type);
      const dir = this.dirFor(it.media, it.subdir);
      await fsp.mkdir(dir, { recursive: true });
      it.file = await uniquePath(dir, name);
      it.name = path.basename(it.file);
      part = it.file + '.part';
      out = fs.createWriteStream(part);
      const reader = r.body.getReader();
      let windowStart = Date.now(), windowBytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        if (!out.write(buf)) await new Promise((res) => out.once('drain', res));
        it.received += buf.length; windowBytes += buf.length;
        const now = Date.now();
        if (now - windowStart >= 1000) { it.speed = windowBytes / ((now - windowStart) / 1000); windowStart = now; windowBytes = 0; }
        this.emit(it);
      }
      await new Promise((res, rej) => out.end((err) => err ? rej(err) : res()));
      out = null;
      await fsp.rename(part, it.file);
      it.state = 'done'; it.speed = 0; if (!it.total) it.total = it.received;
      this.emit(it, true);
      this.onDone(this.pub(it));
    } catch (e) {
      if (out) { try { out.destroy(); } catch (e2) { /* ignore */ } }
      if (part) { try { await fsp.unlink(part); } catch (e2) { /* ignore */ } }
      it.speed = 0;
      if (it.cancelled) { it.state = 'cancelled'; it.error = ''; }
      else { it.state = 'failed'; it.error = e && e.name !== 'AbortError' ? (e.message || 'The download stopped.') : 'The download stopped.'; }
      if (/fetch failed|ENOTFOUND|ECONNRESET|network/i.test(it.error)) it.error = 'The connection dropped. Check you’re online and press Retry.';
      this.emit(it, true);
    } finally {
      it.ctrl = null;
      this.pump();
    }
  }
}

module.exports = { DownloadManager, inspect, normalizeLink, blockedSite, extractMedia, fileNameFrom, safeName, isMediaName, UA };
