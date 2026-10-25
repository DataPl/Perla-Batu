// Fetches CS2 stats from Leetify for every player in players.json
// and writes them to Firebase Realtime Database.
import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';

const API = 'https://api-public.cs-prod.leetify.com';
const KEY = process.env.LEETIFY_API_KEY || '';

// Leetify sometimes gives 0.48 and sometimes 48 for percentages; make it always 0-100.
const pct = (v) => (v == null ? null : Math.round((v <= 1 ? v * 100 : v) * 10) / 10);
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

async function getProfile(steamId) {
  const headers = {};
  if (KEY) {
    headers['_leetify_key'] = KEY;            // header name used by Leetify's public API
    headers['Authorization'] = `Bearer ${KEY}`; // harmless backup
  }
  const res = await fetch(`${API}/v3/profile?steam64_id=${encodeURIComponent(steamId)}`, { headers });
  if (!res.ok) throw new Error(`Leetify answered ${res.status} ${res.statusText}`);
  return res.json();
}

export function toRecord(p) {
  const rating = p.rating || {};
  const stats = p.stats || {};
  const recent = [...(p.recent_matches || [])]
    .sort((a, b) => new Date(a.finished_at) - new Date(b.finished_at))
    .slice(-5);
  const form = recent
    .map((m) => (m.outcome === 'win' ? 'W' : m.outcome === 'loss' ? 'L' : 'D'))
    .join('');
  const openings = [stats.ct_opening_duel_success_percentage, stats.t_opening_duel_success_percentage]
    .filter((v) => v != null);
  const opening = openings.length ? openings.reduce((a, b) => a + b, 0) / openings.length : null;

  return {
    leetifyName: p.name ?? null,
    privacy: p.privacy_mode ?? null,
    premier: p.ranks?.premier ?? null,
    faceitElo: p.ranks?.faceit_elo ?? null,
    winrate: pct(p.winrate),
    totalMatches: p.total_matches ?? null,
    form,
    stats: {
      aim: r1(rating.aim),
      positioning: r1(rating.positioning),
      utility: r1(rating.utility),
      spray: pct(stats.spray_accuracy),
      headshot: pct(stats.accuracy_head),
      opening: pct(opening),
      reactionMs: r1(stats.reaction_time_ms),
    },
    updatedAt: Date.now(),
  };
}

async function main() {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  initializeApp({ credential: cert(sa), databaseURL: process.env.FIREBASE_DATABASE_URL });
  const db = getDatabase();

  const players = JSON.parse(readFileSync('players.json', 'utf8'));
  const old = (await db.ref('players').get()).val() || {};
  const out = {};
  let tried = 0, failed = 0;

  for (const [i, pl] of players.entries()) {
    const id = pl.steam64_id;
    const base = { order: i, name: pl.name, number: pl.number ?? '', role: pl.role ?? '', bio: pl.bio ?? '' };
    out[id] = { ...(old[id] || {}), ...base };   // keep last good stats if this run fails

    if (!/^\d{15,}$/.test(id)) { console.log(`- ${pl.name}: no real Steam64 ID yet, skipping`); continue; }

    tried++;
    try {
      const profile = await getProfile(id);
      const rec = toRecord(profile);
      out[id] = { ...out[id], ...rec };
      console.log(`OK ${pl.name}: premier=${rec.premier} form=${rec.form} stats=${JSON.stringify(rec.stats)}`);
      console.log(`   (raw outcomes seen: ${(profile.recent_matches || []).slice(0, 5).map((m) => m.outcome).join(', ')})`);
    } catch (e) {
      failed++;
      console.error(`FAILED ${pl.name}: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 500)); // be gentle with rate limits
  }

  // JSON round-trip drops "undefined", which Firebase refuses to store
  await db.ref('/').update({
    players: JSON.parse(JSON.stringify(out)),
    meta: { updatedAt: Date.now() },
  });
  console.log(`Wrote ${Object.keys(out).length} players to Firebase.`);
  if (tried > 0 && failed === tried) process.exitCode = 1; // make the Action show a red X
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().then(() => process.exit()).catch((e) => { console.error(e); process.exit(1); });
}
