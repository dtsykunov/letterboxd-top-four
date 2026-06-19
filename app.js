'use strict';

// ============================================================
// CSV Parser
// ============================================================

function parseCSVLine(line) {
  const fields = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      // Quoted field
      let field = '';
      i++; // skip opening quote
      while (i < line.length) {
        if (line[i] === '"') {
          if (i + 1 < line.length && line[i + 1] === '"') {
            field += '"';
            i += 2;
          } else {
            i++; // skip closing quote
            break;
          }
        } else {
          field += line[i++];
        }
      }
      if (i < line.length && line[i] === ',') i++; // skip separator
      fields.push(field);
    } else {
      // Unquoted field
      const end = line.indexOf(',', i);
      if (end === -1) {
        fields.push(line.slice(i));
        break;
      }
      fields.push(line.slice(i, end));
      i = end + 1;
    }
  }
  // Handle trailing comma producing an extra empty field — trim it if fields already
  // has content and is otherwise aligned
  return fields;
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/);
  const films = [];
  // Skip header row (index 0) and blank lines
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const fields = parseCSVLine(line);
    if (fields.length < 4) continue;
    const name = fields[1].trim();
    const year = fields[2].trim();
    const uri  = fields[3].trim();
    if (!name || !uri) continue;
    films.push({ name, year, uri });
  }
  return films;
}

// ============================================================
// ZIP extractor — pure browser JS, no libraries
// ============================================================

async function extractWatchedCSV(arrayBuffer) {
  const data = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);

  // 1. Find End of Central Directory record (search from end)
  let eocdOffset = -1;
  const earliest = Math.max(0, data.length - 22 - 65535);
  for (let i = data.length - 22; i >= earliest; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error('Not a valid ZIP file.');

  const entryCount       = view.getUint16(eocdOffset + 10, true);
  const centralDirOffset = view.getUint32(eocdOffset + 16, true);

  // 2. Walk central directory entries to find watched.csv
  let pos = centralDirOffset;
  let entry = null;

  for (let i = 0; i < entryCount; i++) {
    if (pos + 46 > data.length) break;
    if (view.getUint32(pos, true) !== 0x02014b50) break; // central dir signature

    const compressionMethod = view.getUint16(pos + 10, true);
    const compressedSize    = view.getUint32(pos + 20, true);
    const uncompressedSize  = view.getUint32(pos + 24, true);
    const filenameLen       = view.getUint16(pos + 28, true);
    const extraLen          = view.getUint16(pos + 30, true);
    const commentLen        = view.getUint16(pos + 32, true);
    const localHeaderOffset = view.getUint32(pos + 42, true);

    const filenameBytes = data.slice(pos + 46, pos + 46 + filenameLen);
    const filename = new TextDecoder('utf-8').decode(filenameBytes);

    if (filename === 'watched.csv' || filename.endsWith('/watched.csv')) {
      entry = { compressionMethod, compressedSize, uncompressedSize, localHeaderOffset };
      break;
    }

    pos += 46 + filenameLen + extraLen + commentLen;
  }

  if (!entry) {
    throw new Error(
      'No watched.csv found in this ZIP. Make sure you uploaded your full Letterboxd data export.'
    );
  }

  // 3. Find compressed data via local file header
  const lhOffset = entry.localHeaderOffset;
  if (view.getUint32(lhOffset, true) !== 0x04034b50) {
    throw new Error('Invalid local file header in ZIP.');
  }
  const lhFilenameLen = view.getUint16(lhOffset + 26, true);
  const lhExtraLen    = view.getUint16(lhOffset + 28, true);
  const dataOffset    = lhOffset + 30 + lhFilenameLen + lhExtraLen;

  // Use sizes from central directory — local header may have zeros (data descriptor flag)
  const compressedBlob = arrayBuffer.slice(dataOffset, dataOffset + entry.compressedSize);

  // 4. Decompress
  if (entry.compressionMethod === 0) {
    // Stored — raw bytes
    return new TextDecoder('utf-8').decode(new Uint8Array(compressedBlob));
  } else if (entry.compressionMethod === 8) {
    // Deflate (raw)
    const blob   = new Blob([compressedBlob]);
    const ds     = new DecompressionStream('deflate-raw');
    const stream = blob.stream().pipeThrough(ds);
    return new Response(stream).text();
  } else {
    throw new Error(
      `Unsupported compression method ${entry.compressionMethod} (only Store and Deflate are supported).`
    );
  }
}

// ============================================================
// Tournament Engine — ranked top-4 via single-elim + repechage
// ============================================================

class TournamentEngine {
  constructor(films) {
    const beatenBy = {};
    for (let i = 0; i < films.length; i++) beatenBy[i] = [];

    this.state = {
      films,
      beatenBy,
      ranked: [],
      phase: 'running',
      round: [],
      nextRound: [],
      current: null,
      comparisonCount: 0,
      // Progress / graph bookkeeping
      log: [],        // completed matches & byes: {kind, rank, round, ...}
      roundNum: 1,    // current round within the active mini-tournament
      phaseSize: 0,   // candidate count at the start of the active mini-tournament
    };

    // Handle degenerate cases before starting
    if (films.length === 0) {
      this.state.phase = 'done';
    } else if (films.length === 1) {
      this.state.ranked = [0];
      this.state.phase = 'done';
    } else {
      this.state.round = this._shuffle([...Array(films.length).keys()]);
      this.state.phaseSize = films.length;
      this._advanceLoop();
    }
  }

  // Restore from a plain serialized state object (no _advance call — current is already set)
  static fromState(savedState) {
    const engine = Object.create(TournamentEngine.prototype);
    engine.state = savedState;
    // Backfill fields added after a session may have been saved
    if (!engine.state.log) engine.state.log = [];
    if (engine.state.roundNum == null) engine.state.roundNum = 1;
    if (engine.state.phaseSize == null) engine.state.phaseSize = 0;
    return engine;
  }

  // Advance internal state until we have a matchup (sets state.current) or are done.
  _advanceLoop() {
    const s = this.state;

    while (true) {
      if (s.phase === 'done') return null;

      // Try to form the next pair from the current round
      if (s.round.length >= 2) {
        const a = s.round.shift();
        const b = s.round.shift();
        s.current = [a, b];
        return s.current;
      }

      // Odd count: the last remaining film in this round gets a bye
      if (s.round.length === 1) {
        const byePlayer = s.round.shift();
        s.log.push({ kind: 'bye', rank: s.ranked.length + 1, round: s.roundNum, player: byePlayer });
        s.nextRound.push(byePlayer);
        // fall through to check nextRound
      }

      // Current round exhausted — advance
      if (s.nextRound.length > 1) {
        // More than one winner/bye: start the next sub-round
        s.round = this._shuffle([...s.nextRound]);
        s.nextRound = [];
        s.roundNum++;
        continue;
      }

      if (s.nextRound.length === 1) {
        // Exactly one survivor: winner of this mini-tournament
        const winner = s.nextRound.shift();
        this._rankWinner(winner);
        // _rankWinner may set phase = 'done' or load new round — loop continues
        continue;
      }

      // Both arrays empty — should not happen in normal flow
      s.phase = 'done';
      return null;
    }
  }

  // Rank a winner; then set up the next mini-tournament (or mark done).
  _rankWinner(winner) {
    const s = this.state;
    const target = Math.min(4, s.films.length);

    while (true) {
      s.ranked.push(winner);
      if (s.ranked.length >= target) {
        s.phase = 'done';
        s.round = [];
        s.nextRound = [];
        return;
      }

      const candidates = this._findCandidates();

      if (candidates.length === 0) {
        // Shouldn't happen with well-formed input, but guard it
        s.phase = 'done';
        s.round = [];
        s.nextRound = [];
        return;
      }

      if (candidates.length === 1) {
        // Auto-rank the lone candidate — no comparison needed
        winner = candidates[0];
        // continue the while loop to rank it
      } else {
        // Multiple candidates: start a new mini-tournament
        s.round = this._shuffle(candidates);
        s.nextRound = [];
        s.phaseSize = candidates.length;
        s.roundNum = 1;
        return;
      }
    }
  }

  // Films eligible for the next ranking slot:
  // unranked films whose every conqueror is already ranked.
  _findCandidates() {
    const s = this.state;
    const rankedSet = new Set(s.ranked);
    return [...Array(s.films.length).keys()].filter(
      i => !rankedSet.has(i) && s.beatenBy[i].every(b => rankedSet.has(b))
    );
  }

  _shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Record the user's pick and advance to the next matchup.
  // Returns the next [idA, idB] pair or null if complete.
  choose(winnerId) {
    const s = this.state;
    if (!s.current) throw new Error('No active matchup.');
    const [a, b] = s.current;
    // Normalize to number in case caller passed a string
    const wid = Number(winnerId);
    if (wid !== a && wid !== b) throw new Error('Winner ID is not part of current matchup.');
    const loserId = wid === a ? b : a;
    s.beatenBy[loserId].push(wid);
    if (!s.log) s.log = [];
    s.log.push({ kind: 'match', rank: s.ranked.length + 1, round: s.roundNum, winner: wid, loser: loserId });
    s.nextRound.push(wid);
    s.current = null;
    s.comparisonCount++;
    return this._advanceLoop();
  }

  isComplete() { return this.state.phase === 'done'; }

  // Returns [{name, year, uri, id}, ...]
  getRanking() {
    return this.state.ranked.map(id => ({ ...this.state.films[id], id }));
  }

  // Full leaderboard. Places 1..k are the exact tournament result. The rest
  // can't be strictly ordered (those films were only partially compared), so
  // they are ranked by matchups won — which honestly produces ties. Tied films
  // share a place (competition "1224" ranking). Returns:
  //   { top: [{place, id, film, wins, losses}],
  //     rest: [{place, wins, tied, films: [{id, film, wins, losses}]}] }
  getFullRanking() {
    const s = this.state;
    const n = s.films.length;
    const wins = new Array(n).fill(0);
    const losses = new Array(n).fill(0);
    (s.log || []).forEach(e => {
      if (e.kind === 'match') { wins[e.winner]++; losses[e.loser]++; }
    });

    const rankedSet = new Set(s.ranked);
    const top = s.ranked.map((id, i) => ({
      place: i + 1, id, film: s.films[id], wins: wins[id], losses: losses[id],
    }));

    const rest = [];
    for (let i = 0; i < n; i++) if (!rankedSet.has(i)) rest.push(i);
    // Order by wins desc; films with equal wins are genuinely tied.
    rest.sort((a, b) => wins[b] - wins[a] || s.films[a].name.localeCompare(s.films[b].name));

    const groups = [];
    let above = s.ranked.length;   // count of films already placed
    let idx = 0;
    while (idx < rest.length) {
      const w = wins[rest[idx]];
      const members = [];
      while (idx < rest.length && wins[rest[idx]] === w) {
        const id = rest[idx++];
        members.push({ id, film: s.films[id], wins: wins[id], losses: losses[id] });
      }
      groups.push({ place: above + 1, wins: w, tied: members.length > 1, films: members });
      above += members.length;
    }

    return { top, rest: groups };
  }

  getCurrentPair() { return this.state.current; }

  // Exact progress for the favorite currently being decided.
  // The overall total across all four favorites is NOT knowable in
  // advance (it depends on the user's picks), but a single-elimination
  // of m candidates is always exactly m-1 matchups — so per-favorite
  // progress is exact.
  progress() {
    const s = this.state;
    const target = Math.min(4, s.films.length);
    const rank = Math.min(s.ranked.length + 1, target);
    const phaseTotal = Math.max(0, s.phaseSize - 1);
    const inPlay = s.round.length + s.nextRound.length + (s.current ? 2 : 0);
    const remaining = Math.max(0, inPlay - 1);          // matchups left incl. the live one
    const done = Math.max(0, phaseTotal - remaining);   // matchups fully completed
    const currentNum = Math.min(phaseTotal, done + 1);
    return { rank, target, phaseTotal, done, remaining, currentNum };
  }

  // The per-round shape of a single-elimination of `size` players:
  // [{ matchups, bye }, ...]. Deterministic, so future rounds can be
  // drawn as empty slots without revealing any upcoming pairing.
  static roundSchedule(size) {
    const rounds = [];
    let p = size;
    while (p > 1) {
      const matchups = Math.floor(p / 2);
      const bye = p % 2 === 1;
      rounds.push({ matchups, bye });
      p = matchups + (bye ? 1 : 0); // ceil(p/2)
    }
    return rounds;
  }
}

// ============================================================
// localStorage persistence
// ============================================================

const STORAGE_KEY = 'letterboxd-fav4-v1';

function saveState(films, engine) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      films,
      engineState: engine.state,
    }));
  } catch (_) {
    // Quota exceeded or private browsing — silently ignore
  }
}

function loadSavedState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function clearAllState() {
  localStorage.removeItem(STORAGE_KEY);
}

// ============================================================
// UI — only runs in a browser context
// ============================================================

if (typeof window !== 'undefined') {
  // ---- App-level state ----
  let currentFilms  = null; // Film[]
  let engine        = null; // TournamentEngine

  // ---- DOM refs (populated in init) ----
  let elScreens, elUploadZone, elFileInput, elUploadStatus, elUploadError,
      elStartPicking, elProgress, elCardA, elCardB, elResultsList,
      elProgressBar, elProgressFill, elSubProgress, elBracket, elToggleBracket,
      elUndoMatchup, elUndoResults, elToggleFull, elFullRanking;

  let fullVisible = false;

  // Undo stack — state snapshots taken before each pick (persisted
  // separately from main progress so a quota error can't lose it).
  const UNDO_KEY = 'letterboxd-fav4-undo-v1';
  const UNDO_MAX = 300;
  let undoStack = [];

  // ---- Screen management ----
  function showScreen(name) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById('screen-' + name).classList.add('active');
  }

  // ---- Progress label + bar (built as nodes; all values app-generated) ----
  function renderProgress() {
    while (elProgress.firstChild) elProgress.removeChild(elProgress.firstChild);
    if (!engine) return;
    const p = engine.progress();

    // "Finding favorite #k of 4"
    const rank = document.createElement('strong');
    rank.textContent = `#${p.rank}`;
    elProgress.appendChild(document.createTextNode('Finding favorite '));
    elProgress.appendChild(rank);
    elProgress.appendChild(document.createTextNode(` of ${p.target}`));

    // Determinate bar for the current favorite's mini-tournament
    const pct = p.phaseTotal > 0 ? Math.round((p.done / p.phaseTotal) * 100) : 0;
    elProgressFill.style.width = pct + '%';
    elProgressBar.setAttribute('aria-valuemin', '0');
    elProgressBar.setAttribute('aria-valuemax', String(p.phaseTotal));
    elProgressBar.setAttribute('aria-valuenow', String(p.done));
    elProgressBar.setAttribute(
      'aria-valuetext',
      `Matchup ${p.currentNum} of ${p.phaseTotal} for favorite #${p.rank}`
    );

    // "Matchup X of Y · N total so far"
    const cmp = engine.state.comparisonCount;
    elSubProgress.textContent =
      `Matchup ${p.currentNum} of ${p.phaseTotal} · ${cmp} comparison${cmp !== 1 ? 's' : ''} total`;
  }

  // ============================================================
  // Tournament graph — rounds as columns. Never reveals upcoming
  // pairings: not-yet-played matchups appear only as TBD counts.
  // ============================================================
  const BRACKET_KEY = 'letterboxd-fav4-bracket';
  let bracketVisible = false;

  function bMatchCard(winnerName, loserName) {
    const c = document.createElement('div');
    c.className = 'bmatch done';
    const w = document.createElement('span'); w.className = 'bm-win';  w.textContent = winnerName;
    const l = document.createElement('span'); l.className = 'bm-lose'; l.textContent = loserName;
    c.append(w, l);
    return c;
  }
  function bLiveCard(aName, bName) {
    const c = document.createElement('div');
    c.className = 'bmatch live';
    const tag = document.createElement('span'); tag.className = 'bm-tag'; tag.textContent = 'now';
    const x = document.createElement('span'); x.className = 'bm-name'; x.textContent = aName;
    const vs = document.createElement('span'); vs.className = 'bm-vs'; vs.textContent = 'vs';
    const y = document.createElement('span'); y.className = 'bm-name'; y.textContent = bName;
    c.append(tag, x, vs, y);
    return c;
  }
  function bTbdCard(n) {
    const c = document.createElement('div');
    c.className = 'bmatch tbd';
    c.textContent = n === 1 ? '1 matchup to come' : `${n} matchups to come`;
    return c;
  }
  function bByeChip(name) {
    const c = document.createElement('div');
    c.className = 'bbye';
    c.textContent = name ? `bye · ${name}` : 'bye · to be decided';
    return c;
  }

  function renderBracket() {
    while (elBracket.firstChild) elBracket.removeChild(elBracket.firstChild);
    if (!engine || engine.isComplete()) return;
    const s = engine.state;
    const target = Math.min(4, s.films.length);
    const rank = Math.min(s.ranked.length + 1, target);

    const caption = document.createElement('p');
    caption.className = 'bracket-caption';
    caption.textContent = `Deciding favorite #${rank} — single elimination, winners re-paired at random each round`;
    elBracket.appendChild(caption);

    if (s.ranked.length > 0) {
      const decided = document.createElement('div');
      decided.className = 'bracket-decided';
      s.ranked.forEach((id, i) => {
        const chip = document.createElement('span');
        chip.className = 'decided-chip';
        const b = document.createElement('b'); b.textContent = `#${i + 1}`;
        chip.append(b, document.createTextNode(' ' + s.films[id].name));
        decided.appendChild(chip);
      });
      elBracket.appendChild(decided);
    }

    const cols = document.createElement('div');
    cols.className = 'bracket-cols';

    const schedule = TournamentEngine.roundSchedule(s.phaseSize);
    const phaseLog = (s.log || []).filter(e => e.rank === rank);

    schedule.forEach((round, idx) => {
      const r = idx + 1;
      const col = document.createElement('div');
      col.className = 'bracket-col';

      const head = document.createElement('div');
      head.className = 'bracket-col-head';
      head.textContent = r === schedule.length ? 'Final' : `Round ${r}`;
      col.appendChild(head);

      const matches = phaseLog.filter(e => e.kind === 'match' && e.round === r);
      const byes    = phaseLog.filter(e => e.kind === 'bye'   && e.round === r);
      const live    = (s.current && s.roundNum === r) ? s.current : null;

      matches.forEach(m => col.appendChild(bMatchCard(s.films[m.winner].name, s.films[m.loser].name)));
      if (live) col.appendChild(bLiveCard(s.films[live[0]].name, s.films[live[1]].name));

      let remaining;
      if (r < s.roundNum)       remaining = 0;
      else if (r === s.roundNum) remaining = round.matchups - matches.length - (live ? 1 : 0);
      else                       remaining = round.matchups;
      if (remaining > 0) col.appendChild(bTbdCard(remaining));

      byes.forEach(b => col.appendChild(bByeChip(s.films[b.player].name)));
      if (round.bye && byes.length === 0 && r >= s.roundNum) col.appendChild(bByeChip(null));

      cols.appendChild(col);
    });

    elBracket.appendChild(cols);
  }

  function applyBracketVisibility() {
    elBracket.hidden = !bracketVisible;
    elToggleBracket.setAttribute('aria-expanded', String(bracketVisible));
    elToggleBracket.textContent = bracketVisible ? 'Hide tournament graph' : 'Show tournament graph';
    if (bracketVisible) renderBracket();
  }

  function toggleBracket() {
    bracketVisible = !bracketVisible;
    try { localStorage.setItem(BRACKET_KEY, bracketVisible ? '1' : '0'); } catch (_) {}
    applyBracketVisibility();
  }

  // ---- Validate a URI — only allow https:// and http:// schemes ----
  function safeHref(uri) {
    return /^https?:\/\//i.test(uri) ? uri : '#';
  }

  // ---- Populate a card element ----
  function fillCard(el, filmId) {
    const film = currentFilms[filmId];
    el.querySelector('.film-title').textContent = film.name;
    el.querySelector('.film-year').textContent  = film.year;
    const link = el.querySelector('.letterboxd-link');
    link.href        = safeHref(film.uri);
    link.textContent = 'View on Letterboxd ↗';
    el.dataset.filmId = filmId;
    el.querySelector('.pick-btn').dataset.filmId = filmId;
  }

  // ---- Show/update the matchup screen ----
  function showMatchup() {
    const pair = engine.state.current;
    if (!pair) { showResults(); return; }
    fillCard(elCardA, pair[0]);
    fillCard(elCardB, pair[1]);
    renderProgress();
    if (bracketVisible) renderBracket();
    updateUndoButtons();
    showScreen('matchup');
  }

  // ============================================================
  // Undo — snapshot the engine state before each pick
  // ============================================================
  function snapshotState() {
    // Exclude the (constant) film list to keep snapshots small.
    const { films, ...rest } = engine.state;
    return JSON.parse(JSON.stringify(rest));
  }
  function pushUndo() {
    undoStack.push(snapshotState());
    if (undoStack.length > UNDO_MAX) undoStack.shift();
  }
  function saveUndo() {
    try { localStorage.setItem(UNDO_KEY, JSON.stringify(undoStack)); } catch (_) {}
  }
  function loadUndo() {
    try { const r = localStorage.getItem(UNDO_KEY); undoStack = r ? JSON.parse(r) : []; }
    catch (_) { undoStack = []; }
  }
  function clearUndo() {
    undoStack = [];
    try { localStorage.removeItem(UNDO_KEY); } catch (_) {}
  }
  function updateUndoButtons() {
    const disabled = undoStack.length === 0;
    if (elUndoMatchup) elUndoMatchup.disabled = disabled;
    if (elUndoResults) elUndoResults.disabled = disabled;
  }
  function undoLast() {
    if (undoStack.length === 0) return;
    const snap = undoStack.pop();
    engine = TournamentEngine.fromState({ ...snap, films: currentFilms });
    saveState(currentFilms, engine);
    saveUndo();
    if (engine.isComplete()) showResults();
    else showMatchup();
  }

  // ---- Handle a pick ----
  function handlePick(filmId) {
    pushUndo();
    engine.choose(filmId);
    saveState(currentFilms, engine);
    saveUndo();
    if (engine.isComplete()) {
      showResults();
    } else {
      showMatchup();
    }
  }

  // ============================================================
  // Full ranking (optional) — places 5+ ordered by matchups won,
  // with shared placings noted as ties.
  // ============================================================
  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function renderFullRanking() {
    while (elFullRanking.firstChild) elFullRanking.removeChild(elFullRanking.firstChild);
    if (!engine || !engine.isComplete()) return;
    const { rest } = engine.getFullRanking();
    if (rest.length === 0) return;

    const cap = document.createElement('p');
    cap.className = 'fr-caption';
    cap.textContent = 'Places 1–4 are your exact result. The rest are ranked by matchups won — ' +
      'films that were only compared a few times often share a place.';
    elFullRanking.appendChild(cap);

    const ol = document.createElement('ol');
    ol.className = 'fr-list';

    rest.forEach(group => {
      const li = document.createElement('li');
      li.className = 'fr-row';

      const place = document.createElement('span');
      place.className = 'fr-place';
      place.textContent = ordinal(group.place);
      li.appendChild(place);

      const mid = document.createElement('div');
      mid.className = 'fr-mid';

      if (group.tied) {
        const badge = document.createElement('span');
        badge.className = 'fr-tie';
        badge.textContent = `tie · ${group.films.length} films`;
        mid.appendChild(badge);
      }

      const films = document.createElement('div');
      films.className = 'fr-films';
      group.films.forEach(m => {
        const row = document.createElement('div');
        row.className = 'fr-film';
        const t = document.createElement('span'); t.className = 'fr-title'; t.textContent = m.film.name;
        const y = document.createElement('span'); y.className = 'fr-year'; y.textContent = ` (${m.film.year})`;
        const a = document.createElement('a');
        a.className = 'letterboxd-link';
        a.href = safeHref(m.film.uri);
        a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.textContent = 'Letterboxd ↗';
        row.append(t, y, document.createTextNode(' '), a);
        films.appendChild(row);
      });
      mid.appendChild(films);
      li.appendChild(mid);

      const w = document.createElement('span');
      w.className = 'fr-wins';
      w.textContent = group.wins === 1 ? '1 win' : `${group.wins} wins`;
      li.appendChild(w);

      ol.appendChild(li);
    });

    elFullRanking.appendChild(ol);
  }

  function applyFullVisibility() {
    elFullRanking.hidden = !fullVisible;
    elToggleFull.setAttribute('aria-expanded', String(fullVisible));
    elToggleFull.textContent = fullVisible ? 'Hide full ranking' : 'Show full ranking (places 5+)';
    if (fullVisible) renderFullRanking();
  }

  function toggleFull() {
    fullVisible = !fullVisible;
    applyFullVisibility();
  }

  // ---- Show results ----
  function showResults() {
    const ranking = engine.getRanking();
    // Clear safely (no untrusted HTML — only our own structural empty state)
    while (elResultsList.firstChild) elResultsList.removeChild(elResultsList.firstChild);

    ranking.forEach((film, i) => {
      const li = document.createElement('li');

      const rankSpan = document.createElement('span');
      rankSpan.className = 'rank-number';
      rankSpan.textContent = `#${i + 1}`;

      const titleSpan = document.createElement('span');
      titleSpan.className = 'rank-title';
      titleSpan.textContent = film.name;

      const yearSpan = document.createElement('span');
      yearSpan.className = 'rank-year';
      yearSpan.textContent = `(${film.year})`;

      const link = document.createElement('a');
      link.className = 'letterboxd-link';
      link.href = safeHref(film.uri);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Letterboxd ↗';

      li.appendChild(rankSpan);
      li.appendChild(document.createTextNode(' '));
      li.appendChild(titleSpan);
      li.appendChild(document.createTextNode(' '));
      li.appendChild(yearSpan);
      li.appendChild(document.createTextNode(' '));
      li.appendChild(link);
      elResultsList.appendChild(li);
    });

    // Full-ranking toggle: only offered when there are films beyond the top 4
    const hasRest = engine.getFullRanking().rest.length > 0;
    elToggleFull.hidden = !hasRest;
    fullVisible = false;
    applyFullVisibility();

    updateUndoButtons();
    showScreen('results');
  }

  // ---- Show an upload error ----
  function showUploadError(msg) {
    elUploadError.textContent = msg;
    elUploadError.hidden = false;
    elUploadStatus.hidden = true;
    elStartPicking.hidden = true;
  }

  // ---- Process a file (File object) ----
  async function processFile(file) {
    elUploadError.hidden = true;
    elUploadStatus.hidden = true;
    elStartPicking.hidden = true;

    // Detect type
    const isZip = file.name.toLowerCase().endsWith('.zip') ||
                  (await peekSignature(file));
    const isCsv = file.name.toLowerCase().endsWith('.csv');

    if (!isZip && !isCsv) {
      showUploadError('Please upload a .zip (Letterboxd export) or a .csv file.');
      return;
    }

    let csvText;
    try {
      if (isZip) {
        const buf = await file.arrayBuffer();
        csvText = await extractWatchedCSV(buf);
      } else {
        csvText = await file.text();
      }
    } catch (err) {
      showUploadError(err.message || 'Could not read the file.');
      return;
    }

    const films = parseCSV(csvText);

    if (films.length === 0) {
      showUploadError('No films found in the CSV. Is this the right file?');
      return;
    }
    if (films.length < 2) {
      showUploadError('At least 2 films are needed for a comparison. Your list has only 1.');
      return;
    }

    currentFilms = films;
    clearAllState(); // Fresh start whenever a new file is loaded
    clearUndo();
    elUploadStatus.textContent = `${films.length} film${films.length !== 1 ? 's' : ''} loaded.`;
    elUploadStatus.hidden = false;
    elStartPicking.hidden = false;
  }

  // Returns true if the file's first 4 bytes are PK\x03\x04 (ZIP signature)
  async function peekSignature(file) {
    try {
      const slice = file.slice(0, 4);
      const buf = await slice.arrayBuffer();
      const bytes = new Uint8Array(buf);
      return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
    } catch (_) {
      return false;
    }
  }

  // ---- Start / restart tournament ----
  function startTournament() {
    engine = new TournamentEngine(currentFilms);
    clearUndo();
    saveState(currentFilms, engine);
    showMatchup();
  }

  // ---- "Start over" — same films, fresh tournament ----
  function startOver() {
    startTournament();
  }

  // ---- "Use a different file" / "Reset" — clear everything ----
  function useDifferentFile() {
    // Guard against wiping an in-progress tournament by accident.
    if (engine && !engine.isComplete() &&
        !confirm('Reset and start fresh with other data? Your current progress will be lost.')) {
      return;
    }
    clearAllState();
    clearUndo();
    currentFilms = null;
    engine = null;
    elUploadError.hidden = true;
    elUploadStatus.hidden = true;
    elStartPicking.hidden = true;
    elFileInput.value = '';
    showScreen('upload');
  }

  // ---- Drag and drop helpers ----
  function preventDefault(e) { e.preventDefault(); e.stopPropagation(); }

  // ---- Main init ----
  function init() {
    // Cache DOM elements
    elUploadZone   = document.getElementById('upload-zone');
    elFileInput    = document.getElementById('file-input');
    elUploadStatus = document.getElementById('upload-status');
    elUploadError  = document.getElementById('upload-error');
    elStartPicking = document.getElementById('btn-start-picking');
    elProgress     = document.getElementById('matchup-progress');
    elCardA        = document.getElementById('card-a');
    elCardB        = document.getElementById('card-b');
    elResultsList  = document.getElementById('results-list');
    elProgressBar  = document.getElementById('progress-bar');
    elProgressFill = document.getElementById('progress-bar-fill');
    elSubProgress  = document.getElementById('matchup-subprogress');
    elBracket      = document.getElementById('bracket-panel');
    elToggleBracket = document.getElementById('btn-toggle-bracket');
    elUndoMatchup  = document.getElementById('btn-undo-matchup');
    elUndoResults  = document.getElementById('btn-undo-results');
    elUndoMatchup.addEventListener('click', undoLast);
    elUndoResults.addEventListener('click', undoLast);
    elToggleFull   = document.getElementById('btn-toggle-full');
    elFullRanking  = document.getElementById('full-ranking');
    elToggleFull.addEventListener('click', toggleFull);

    // Restore the graph toggle preference
    try { bracketVisible = localStorage.getItem(BRACKET_KEY) === '1'; } catch (_) {}
    elToggleBracket.addEventListener('click', toggleBracket);
    applyBracketVisibility();

    // --- Screen: Intro ---
    document.getElementById('btn-get-started').addEventListener('click', () => {
      showScreen('upload');
    });

    // --- Screen: Upload ---
    elFileInput.addEventListener('change', (e) => {
      if (e.target.files[0]) processFile(e.target.files[0]);
    });

    // Drag and drop
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(ev => {
      elUploadZone.addEventListener(ev, preventDefault);
    });
    elUploadZone.addEventListener('dragenter', () => elUploadZone.classList.add('drag-over'));
    elUploadZone.addEventListener('dragover',  () => elUploadZone.classList.add('drag-over'));
    elUploadZone.addEventListener('dragleave', () => elUploadZone.classList.remove('drag-over'));
    elUploadZone.addEventListener('drop', (e) => {
      elUploadZone.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file) processFile(file);
    });

    // Clicking the drop zone also triggers the file picker
    elUploadZone.addEventListener('click', (e) => {
      if (!e.target.closest('#file-input') && !e.target.closest('label')) {
        elFileInput.click();
      }
    });

    elStartPicking.addEventListener('click', () => {
      startTournament();
    });

    // --- Screen: Matchup ---
    function setupCard(cardEl) {
      // Clicking the pick button picks that film
      cardEl.querySelector('.pick-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        handlePick(Number(e.currentTarget.dataset.filmId));
      });
      // Clicking anywhere else on the card (but not the letterboxd link) also picks
      cardEl.addEventListener('click', (e) => {
        if (!e.target.closest('.letterboxd-link') && !e.target.closest('.pick-btn')) {
          handlePick(Number(cardEl.dataset.filmId));
        }
      });
      // Keyboard: Enter/Space on card div
      cardEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handlePick(Number(cardEl.dataset.filmId));
        }
      });
    }
    setupCard(elCardA);
    setupCard(elCardB);

    // Arrow key shortcuts: ← = left card, → = right card
    document.addEventListener('keydown', (e) => {
      if (!document.getElementById('screen-matchup').classList.contains('active')) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        handlePick(Number(elCardA.dataset.filmId));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        handlePick(Number(elCardB.dataset.filmId));
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        undoLast();
      }
    });

    document.getElementById('btn-restart-matchup').addEventListener('click', startOver);
    document.getElementById('btn-reset-matchup').addEventListener('click', useDifferentFile);

    // --- Screen: Results ---
    document.getElementById('btn-restart-results').addEventListener('click', startOver);
    document.getElementById('btn-different-file').addEventListener('click', useDifferentFile);

    // --- Resume saved session ---
    const saved = loadSavedState();
    if (saved && saved.films && saved.engineState) {
      currentFilms = saved.films;
      engine = TournamentEngine.fromState(saved.engineState);
      loadUndo();
      if (engine.isComplete()) {
        showResults();
      } else {
        showMatchup();
      }
    } else {
      showScreen('intro');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}

// ============================================================
// Node.js exports (for testing)
// ============================================================

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseCSVLine, parseCSV, TournamentEngine };
}
