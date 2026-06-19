#!/usr/bin/env node
'use strict';

// ============================================================
// Test suite for app.js (Node.js, no test framework needed)
// ============================================================

const {
  parseCSV, parseCSVLine, TournamentEngine,
  varintWrite, varintRead,
  buildSharePayload, payloadToState,
  serializePayload, deserializePayload,
  b64urlFromBytes, bytesFromB64url,
  encodeShare, decodeShare,
} = require('./app.js');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log('  PASS:', message);
    passed++;
  } else {
    console.error('  FAIL:', message);
    failed++;
  }
}

function assertEqual(actual, expected, message) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log('  PASS:', message);
    passed++;
  } else {
    console.error('  FAIL:', message);
    console.error('    expected:', JSON.stringify(expected));
    console.error('    actual:  ', JSON.stringify(actual));
    failed++;
  }
}

// ============================================================
// 1. CSV line parser
// ============================================================
console.log('\n--- CSV line parser ---');

assertEqual(
  parseCSVLine('2018-11-13,Stop Making Sense,1984,https://boxd.it/1ygo'),
  ['2018-11-13', 'Stop Making Sense', '1984', 'https://boxd.it/1ygo'],
  'simple unquoted line'
);

assertEqual(
  parseCSVLine('2020-01-01,"Title, With Comma",2001,https://boxd.it/abc'),
  ['2020-01-01', 'Title, With Comma', '2001', 'https://boxd.it/abc'],
  'quoted field with embedded comma'
);

assertEqual(
  parseCSVLine('2020-01-01,"Title with ""Quotes""",2001,https://boxd.it/abc'),
  ['2020-01-01', 'Title with "Quotes"', '2001', 'https://boxd.it/abc'],
  'quoted field with escaped double-quotes'
);

assertEqual(
  parseCSVLine('"Quoted","All","Fields","Here"'),
  ['Quoted', 'All', 'Fields', 'Here'],
  'all fields quoted'
);

// ============================================================
// 2. Full CSV parser on extracted watchlist.csv
// ============================================================
console.log('\n--- Full CSV parser ---');

const csvPath = '/tmp/watchlist.csv';
if (fs.existsSync(csvPath)) {
  const text = fs.readFileSync(csvPath, 'utf-8');
  const films = parseCSV(text);

  assert(films.length === 20, `parsed 20 films from real watchlist.csv (got ${films.length})`);
  assert(films.every(f => f.name && f.year && f.uri), 'every film has name, year, and uri');
  assert(
    films.every(f => /^https?:\/\//.test(f.uri)),
    'every URI is an https:// link'
  );
  // First film sanity-check (real data)
  assertEqual(films[0].name, 'Twenty Years Later', 'first film name matches known value');
  assertEqual(films[0].uri,  'https://boxd.it/33Oo', 'first film URI matches known value');
  // Last film
  assertEqual(films[films.length - 1].name, 'A City of Sadness', 'last film name matches known value');

  console.log('  Films:', films.map(f => `${f.name} (${f.year})`).join(', '));
} else {
  console.log('  SKIP: /tmp/watchlist.csv not found. Run: python3 -c "import zipfile; z=zipfile.ZipFile(\'/tmp/watchlist.zip\'); open(\'/tmp/watchlist.csv\',\'wb\').write(z.read(\'watchlist.csv\'))"');
}

// ============================================================
// 3. Tournament engine — correctness across pool sizes
// ============================================================
console.log('\n--- Tournament engine ---');

// Simulate a tournament with deterministic choices: always prefer the film
// with the smaller index. The correct top-4 by this order is [0,1,2,3].
function simulateTournament(n) {
  const films = Array.from({ length: n }, (_, i) => ({
    name: `Film ${i}`,
    year: String(2000 + i),
    uri: `https://boxd.it/${i}`,
  }));

  const engine = new TournamentEngine(films);
  let iterations = 0;
  const maxIter = n * n + 10; // safety limit

  while (!engine.isComplete()) {
    if (iterations++ > maxIter) {
      throw new Error(`Engine did not complete after ${maxIter} iterations for n=${n}`);
    }
    const pair = engine.state.current;
    if (!pair) break;
    // Always pick the lower-index film (deterministic "preference")
    engine.choose(Math.min(pair[0], pair[1]));
  }

  return engine;
}

const testSizes = [2, 3, 5, 8, 16, 20];

for (const n of testSizes) {
  console.log(`\n  n=${n}:`);
  const engine = simulateTournament(n);
  const ranking = engine.getRanking();
  const expectedLen = Math.min(4, n);
  const cmpCount = engine.state.comparisonCount;

  assert(engine.isComplete(), `engine is complete`);
  assert(ranking.length === expectedLen, `ranked ${expectedLen} films (got ${ranking.length})`);

  // Top-k by "prefer lower index" must equal [0,1,2,...,k-1]
  const expectedIds = Array.from({ length: expectedLen }, (_, i) => i);
  const actualIds   = ranking.map(f => f.id);
  assertEqual(actualIds, expectedIds, `ranking order is correct: [${actualIds}]`);

  // Sanity-check comparison count: should be < 3*n for any n
  assert(cmpCount < 3 * n, `comparison count ${cmpCount} < 3*${n} (=${3*n})`);
  // And at least n-1 (can't find a winner without at least n-1 comparisons)
  const minCmp = n <= 4 ? n - 1 : n - 1;
  assert(cmpCount >= minCmp, `comparison count ${cmpCount} >= ${minCmp}`);
  console.log(`  Comparisons: ${cmpCount} (for n=${n})`);
}

// ============================================================
// 4. Edge cases
// ============================================================
console.log('\n--- Edge cases ---');

// 1 film — immediately done, ranked
{
  const e = new TournamentEngine([{ name: 'Solo', year: '2000', uri: 'https://boxd.it/x' }]);
  assert(e.isComplete(), '1 film: engine immediately complete');
  assertEqual(e.getRanking().map(f => f.name), ['Solo'], '1 film: ranked correctly');
  assertEqual(e.state.comparisonCount, 0, '1 film: 0 comparisons');
}

// 2 films — exactly 1 comparison needed
{
  const e = simulateTournament(2);
  assert(e.isComplete(), '2 films: engine complete');
  assertEqual(e.getRanking().length, 2, '2 films: 2 results');
  assertEqual(e.state.comparisonCount, 1, '2 films: exactly 1 comparison');
}

// 3 films — 2 ranked; need 3 comparisons (main:2, repechage:1)
{
  const e = simulateTournament(3);
  assert(e.isComplete(), '3 films: engine complete');
  assertEqual(e.getRanking().length, 3, '3 films: 3 results');
  console.log(`  3 films: ${e.state.comparisonCount} comparisons`);
}

// fromState() restores correctly mid-tournament
{
  const films = Array.from({ length: 6 }, (_, i) => ({
    name: `Film ${i}`, year: String(2000 + i), uri: `https://boxd.it/${i}`,
  }));
  const engine1 = new TournamentEngine(films);
  // Make one choice
  const pair1 = engine1.state.current;
  engine1.choose(Math.min(pair1[0], pair1[1]));
  // Serialize + restore
  const savedState = JSON.parse(JSON.stringify(engine1.state));
  const engine2 = TournamentEngine.fromState(savedState);
  // Continue from restored engine
  while (!engine2.isComplete()) {
    const pair = engine2.state.current;
    engine2.choose(Math.min(pair[0], pair[1]));
  }
  const ranking = engine2.getRanking();
  assertEqual(ranking.map(f => f.id), [0, 1, 2, 3], 'fromState() resume produces correct ranking');
}

// ============================================================
// 4b. Progress + tournament-graph bookkeeping
// ============================================================
console.log('\n--- Progress & graph bookkeeping ---');

// A single-elimination of m players is always exactly m-1 matchups,
// so the round schedule (used to draw the graph) must total m-1.
for (const m of [2, 3, 5, 8, 16, 20, 33, 189]) {
  const total = TournamentEngine.roundSchedule(m).reduce((s, r) => s + r.matchups, 0);
  assertEqual(total, m - 1, `roundSchedule(${m}) totals ${m - 1} matchups`);
}

// Across a full run, the number of logged matches equals comparisonCount.
for (const n of [5, 8, 16, 20]) {
  const e = simulateTournament(n);
  const matchLogs = e.state.log.filter(x => x.kind === 'match').length;
  assertEqual(matchLogs, e.state.comparisonCount, `n=${n}: logged matches === comparisonCount`);
}

// progress() invariants must hold on every matchup of a run.
{
  const films = Array.from({ length: 16 }, (_, i) => ({
    name: `F${i}`, year: '2000', uri: `https://boxd.it/${i}`,
  }));
  const e = new TournamentEngine(films);
  let ok = true;
  while (!e.isComplete()) {
    const p = e.progress();
    if (!(p.phaseTotal === e.state.phaseSize - 1 &&
          p.done + p.remaining === p.phaseTotal &&
          p.currentNum >= 1 && p.currentNum <= p.phaseTotal &&
          p.rank >= 1 && p.rank <= p.target)) { ok = false; break; }
    const pair = e.state.current;
    e.choose(Math.min(pair[0], pair[1]));
  }
  assert(ok, 'progress() invariants hold on every matchup (n=16)');
}

// fromState() backfills graph fields for sessions saved before the feature existed.
{
  const legacy = {
    films: [{ name: 'A', year: '1', uri: '#' }, { name: 'B', year: '1', uri: '#' }],
    beatenBy: { 0: [], 1: [] },
    ranked: [], phase: 'running', round: [], nextRound: [], current: [0, 1], comparisonCount: 0,
  };
  const e = TournamentEngine.fromState(legacy);
  assert(Array.isArray(e.state.log) && e.state.roundNum === 1, 'fromState() backfills log/roundNum for legacy state');
}

// Undo mechanism: a snapshot taken before a pick restores that exact matchup.
{
  const films = Array.from({ length: 8 }, (_, i) => ({
    name: `F${i}`, year: '2000', uri: `https://boxd.it/${i}`,
  }));
  const e = new TournamentEngine(films);
  for (let k = 0; k < 3; k++) { const p = e.state.current; e.choose(Math.min(p[0], p[1])); }

  const before = e.state.current.slice();
  const beforeCount = e.state.comparisonCount;
  const { films: _f, ...snap } = e.state;          // snapshot excludes the film list
  const snapClone = JSON.parse(JSON.stringify(snap));

  const p = e.state.current; e.choose(Math.min(p[0], p[1]));
  assert(e.state.comparisonCount === beforeCount + 1, 'undo test: a pick advanced the count');

  const restored = TournamentEngine.fromState({ ...snapClone, films });
  assertEqual(restored.state.current, before, 'undo restores the exact prior matchup');
  assertEqual(restored.state.comparisonCount, beforeCount, 'undo restores the prior comparison count');

  while (!restored.isComplete()) { const q = restored.state.current; restored.choose(Math.min(q[0], q[1])); }
  assertEqual(restored.getRanking().map(f => f.id), [0, 1, 2, 3], 'undo-restored engine still completes correctly');
}

// ============================================================
// 4c. Full ranking (places 5+) with ties
// ============================================================
console.log('\n--- Full ranking (places 5+) ---');

// Deterministic, hand-built completed state to check tie grouping + competition ranking.
{
  const films = Array.from({ length: 7 }, (_, i) => ({
    name: `M${i}`, year: '2000', uri: `https://boxd.it/${i}`,
  }));
  const state = {
    films,
    beatenBy: {}, ranked: [0, 1, 2, 3], phase: 'done',
    round: [], nextRound: [], current: null, comparisonCount: 4,
    roundNum: 1, phaseSize: 0,
    log: [
      { kind: 'match', winner: 4, loser: 6 },
      { kind: 'match', winner: 4, loser: 5 },
      { kind: 'match', winner: 5, loser: 6 },
      { kind: 'match', winner: 5, loser: 6 },
    ],
  };
  const e = TournamentEngine.fromState(state);
  const { top, rest } = e.getFullRanking();

  assertEqual(top.map(t => t.place), [1, 2, 3, 4], 'full ranking: top places are 1–4');
  assertEqual(rest.length, 2, 'full ranking: two groups beyond the top 4');
  assertEqual(rest[0].place, 5, 'first rest group is place 5');
  assert(rest[0].tied === true && rest[0].films.length === 2, 'place 5 is a tie of 2 films (M4 & M5, both 2 wins)');
  assertEqual(rest[0].wins, 2, 'tied group has 2 wins each');
  assertEqual(rest[1].place, 7, 'next group is place 7 (competition ranking skips 6)');
  assert(rest[1].tied === false && rest[1].films[0].id === 6 && rest[1].wins === 0, 'place 7 is M6 with 0 wins');
}

// Invariants over real simulated runs.
for (const n of [6, 8, 16, 20]) {
  const e = simulateTournament(n);
  const { top, rest } = e.getFullRanking();

  // Every film appears exactly once across top + rest.
  const ids = new Set(top.map(t => t.id));
  rest.forEach(g => g.films.forEach(m => ids.add(m.id)));
  assert(ids.size === n, `n=${n}: every film appears exactly once in the full ranking`);

  // Total wins recorded equals the number of comparisons.
  let totalWins = 0;
  top.forEach(t => totalWins += t.wins);
  rest.forEach(g => g.films.forEach(m => totalWins += m.wins));
  assertEqual(totalWins, e.state.comparisonCount, `n=${n}: total wins === comparison count`);

  // Rest groups: wins strictly decrease across groups, and competition ranking is correct.
  let above = top.length, ok = true;
  for (const g of rest) {
    if (g.place !== above + 1) { ok = false; break; }
    above += g.films.length;
  }
  assert(ok, `n=${n}: rest uses correct competition (1224) placing`);
  const winSeq = rest.map(g => g.wins);
  assert(winSeq.every((w, i) => i === 0 || winSeq[i - 1] > w), `n=${n}: groups are strictly ordered by wins`);
}

// ============================================================
// 5. Zero network-request check (grep)
// ============================================================
console.log('\n--- Network request check ---');

const appJs = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8');
const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
const stylesCss = fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf-8');

const allSource = appJs + indexHtml + stylesCss;

// Patterns that would indicate external network calls
const forbidden = [
  /\bfetch\s*\(/,
  /new\s+XMLHttpRequest/,
  /\bImage\b.*src\s*=/,
  /<img\s[^>]*src\s*=\s*["']https?:/i,
  /<iframe/i,
];
for (const pattern of forbidden) {
  const match = allSource.match(pattern);
  // Special case: fetch is used inside extractWatchlistCSV as part of "new Response(...).text()"
  // which is a local stream, not an external fetch. We allow "new Response" but not standalone fetch().
  if (pattern.source === '\\bfetch\\s*\\(' && match) {
    // Check if it's actually a standalone fetch()
    const fetches = allSource.match(/\bfetch\s*\(/g) || [];
    // Our code has no standalone fetch() calls — Response.text() uses Response constructor, not fetch()
    assert(fetches.length === 0, `no standalone fetch() calls (found: ${fetches.join(', ')})`);
  } else {
    assert(!match, `no ${pattern} in source files`);
  }
}
assert(!/<img/i.test(appJs), 'no <img> tags in app.js');
assert(!/<img/i.test(indexHtml.replace(/<svg[^]*?<\/svg>/g, '')), 'no <img> tags in index.html (outside SVG)');

// ============================================================
// 6. Share round-trip tests (async)
// ============================================================

(async function shareTests() {
  console.log('\n--- Share round-trip ---');

  // Build a completed engine with 8 films
  const films8 = Array.from({ length: 8 }, (_, i) => ({
    name: `Film ${i}`,
    year: String(2000 + i),
    uri: `https://boxd.it/${i}aaa`,
  }));
  const eng8 = new TournamentEngine(films8);
  while (!eng8.isComplete()) {
    const pair = eng8.state.current;
    eng8.choose(Math.min(pair[0], pair[1]));
  }

  // buildSharePayload → encodeShare → decodeShare → payload deep-equals
  const state8 = eng8.state;
  const payload8 = buildSharePayload(state8, 'Dima');

  // Serialization round-trip
  const serialized = serializePayload(payload8);
  const deser = deserializePayload(serialized);
  assertEqual(deser.nick, payload8.nick, 'serialize→deserialize: nick matches');
  assertEqual(deser.f.length, payload8.f.length, 'serialize→deserialize: film count matches');
  assertEqual(deser.t, payload8.t, 'serialize→deserialize: top-4 indices match');
  assertEqual(deser.l.length, payload8.l.length, 'serialize→deserialize: match count matches');
  for (let i = 0; i < deser.l.length; i++) {
    if (deser.l[i].w !== payload8.l[i].w || deser.l[i].l !== payload8.l[i].l) {
      assert(false, `serialize→deserialize: match[${i}] differs`);
    }
  }
  assert(true, 'serialize→deserialize: all matches match');

  // b64url byte round-trip
  const testBytes = new Uint8Array([0, 127, 128, 255, 64, 32, 16]);
  const b64 = b64urlFromBytes(testBytes);
  const back = bytesFromB64url(b64);
  assertEqual(Array.from(back), Array.from(testBytes), 'b64url byte round-trip');

  // encodeShare → decodeShare
  const encoded = await encodeShare(payload8);
  assert(typeof encoded === 'string' && encoded.length > 0, 'encodeShare returns a non-empty string');
  const decoded = await decodeShare(encoded);
  assertEqual(decoded.nick, payload8.nick, 'encode→decode: nick matches');
  assertEqual(decoded.f.length, payload8.f.length, 'encode→decode: film count matches');
  assertEqual(decoded.t, payload8.t, 'encode→decode: top-4 indices match');
  assertEqual(decoded.l.length, payload8.l.length, 'encode→decode: match count matches');

  // payloadToState → TournamentEngine.fromState reproduces getRanking()
  const restoredState = payloadToState(decoded);
  const restoredEngine = TournamentEngine.fromState(restoredState);
  const origRanking = eng8.getRanking().map(f => f.id);
  const restoredRanking = restoredEngine.getRanking().map(f => f.id);
  assertEqual(restoredRanking, origRanking, 'payloadToState+fromState reproduces original top-4 ranking');

  // idxWidth=2 case: 300 films
  const films300 = Array.from({ length: 300 }, (_, i) => ({
    name: `Movie ${i}`,
    year: String(1950 + (i % 74)),
    uri: `https://boxd.it/${i}xx`,
  }));
  const eng300 = new TournamentEngine(films300);
  while (!eng300.isComplete()) {
    const pair = eng300.state.current;
    eng300.choose(Math.min(pair[0], pair[1]));
  }
  const payload300 = buildSharePayload(eng300.state, 'Test');
  const enc300 = await encodeShare(payload300);
  const dec300 = await decodeShare(enc300);
  const st300 = payloadToState(dec300);
  const re300 = TournamentEngine.fromState(st300);
  const orig300 = eng300.getRanking().map(f => f.id);
  const rest300 = re300.getRanking().map(f => f.id);
  assertEqual(rest300, orig300, 'idxWidth=2 (300 films): round-trip reproduces top-4 ranking');

  // varint round-trip for edge values
  function varintRoundTrip(n) {
    const arr = [];
    varintWrite(arr, n);
    const bytes = new Uint8Array(arr);
    const { value } = varintRead(bytes, 0);
    return value;
  }
  for (const v of [0, 1, 127, 128, 255, 1984, 10000, 65535]) {
    const rt = varintRoundTrip(v);
    assertEqual(rt, v, `varint round-trip: ${v}`);
  }

  // ============================================================
  // Summary
  // ============================================================
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
