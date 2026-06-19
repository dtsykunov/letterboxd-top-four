'use strict';

// ============================================================
// inflateRaw — raw DEFLATE inflater (RFC 1951), no zlib wrapper.
// Based on the tinf algorithm by Joergen Ibsen (MIT/PD).
// The tree table stores symbol counts per bit-length; decodeSymbol
// walks it by accumulating codes until the current value fits.
// Returns Uint8Array of decompressed data.
// ============================================================

function inflateRaw(inputBytes) {
  // ---- Bit reader state ----
  let src      = 0;   // next byte index in inputBytes
  let bitbuf   = 0;   // accumulated bits (LSB-first)
  let bitcount = 0;   // how many bits are in bitbuf

  function readBit() {
    if (bitcount === 0) {
      bitbuf   = inputBytes[src++];
      bitcount = 8;
    }
    const b = bitbuf & 1;
    bitbuf >>>= 1;
    bitcount--;
    return b;
  }

  function readBits(n) {
    let v = 0;
    for (let i = 0; i < n; i++) v |= readBit() << i;
    return v;
  }

  // ---- Huffman tree: {counts[1..15], syms[]} ----
  // counts[len] = number of codes of that bit-length.
  // syms is the canonical order (sorted by length, then by code value).
  function buildTree(lengths, offset, n) {
    const counts = new Uint16Array(16); // counts[1..15]
    for (let i = 0; i < n; i++) {
      if (lengths[offset + i] > 0) counts[lengths[offset + i]]++;
    }

    // Build syms array: enumerate in canonical order
    const offsets = new Uint16Array(16);
    let total = 0;
    for (let len = 1; len <= 15; len++) {
      offsets[len] = total;
      total += counts[len];
    }

    const syms = new Uint16Array(total);
    for (let i = 0; i < n; i++) {
      const len = lengths[offset + i];
      if (len > 0) syms[offsets[len]++] = i;
    }

    return { counts, syms };
  }

  // Decode one symbol using the "count table" approach:
  // We try each bit-length from 1 upward. We read bits one by one and
  // maintain a running integer `code`. For each bit-length `len`, we
  // check if `code` is within the range assigned to that length.
  // The range is [first..first+counts[len]-1] where `first` is the
  // canonical first code at this length.
  function decodeSymbol(tree) {
    const { counts, syms } = tree;
    let code = 0;
    let first = 0;
    let symIdx = 0;
    for (let len = 1; len <= 15; len++) {
      code |= readBit();
      const count = counts[len];
      if (code - count < first) {
        // Symbol index within this length: code - first
        return syms[symIdx + (code - first)];
      }
      symIdx += count;
      first   = (first + count) << 1;
      code  <<= 1;
    }
    throw new Error('inflateRaw: Huffman decode error');
  }

  // ---- RFC 1951 length/distance tables ----
  const LENGTH_BASE  = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
  const LENGTH_EXTRA = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
  const DIST_BASE    = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
  const DIST_EXTRA   = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];

  // ---- Fixed Huffman trees (RFC 1951 §3.2.6) ----
  function buildFixedLitTree() {
    const lens = new Uint8Array(288);
    let i = 0;
    for (; i < 144; i++) lens[i] = 8;
    for (; i < 256; i++) lens[i] = 9;
    for (; i < 280; i++) lens[i] = 7;
    for (; i < 288; i++) lens[i] = 8;
    return buildTree(lens, 0, 288);
  }

  function buildFixedDistTree() {
    const lens = new Uint8Array(32);
    for (let i = 0; i < 32; i++) lens[i] = 5;
    return buildTree(lens, 0, 32);
  }

  const FIXED_LT = buildFixedLitTree();
  const FIXED_DT = buildFixedDistTree();

  // ---- Output buffer ----
  let out = new Uint8Array(Math.max(inputBytes.length * 3, 256));
  let dst = 0;

  function grow(n) {
    if (dst + n > out.length) {
      const next = new Uint8Array(Math.max(out.length * 2, dst + n + 256));
      next.set(out.subarray(0, dst));
      out = next;
    }
  }

  function copyMatch(dist, length) {
    grow(length);
    for (let i = 0; i < length; i++) {
      out[dst] = out[dst - dist];
      dst++;
    }
  }

  // ---- Decode one compressed block ----
  function inflateBlock(lt, dt) {
    let sym;
    for (;;) {
      sym = decodeSymbol(lt);
      if (sym === 256) break;
      if (sym < 256) {
        grow(1);
        out[dst++] = sym;
      } else {
        const lenIdx = sym - 257;
        const length = LENGTH_BASE[lenIdx] + readBits(LENGTH_EXTRA[lenIdx]);
        const dSym   = decodeSymbol(dt);
        const dist   = DIST_BASE[dSym]    + readBits(DIST_EXTRA[dSym]);
        copyMatch(dist, length);
      }
    }
  }

  // ---- Uncompressed block ----
  function inflateStored() {
    bitcount = 0; bitbuf = 0; // discard partial byte
    const len = inputBytes[src] | (inputBytes[src + 1] << 8);
    src += 4; // skip len + nlen
    grow(len);
    for (let i = 0; i < len; i++) out[dst++] = inputBytes[src++];
  }

  // ---- Dynamic Huffman block ----
  function inflateDynamic() {
    const hlit  = readBits(5) + 257;
    const hdist = readBits(5) + 1;
    const hclen = readBits(4) + 4;

    const CLEN_ORDER = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];
    const clenLens = new Uint8Array(19);
    for (let i = 0; i < hclen; i++) clenLens[CLEN_ORDER[i]] = readBits(3);

    const clt = buildTree(clenLens, 0, 19);
    const lens = new Uint8Array(hlit + hdist);
    let i = 0;
    while (i < hlit + hdist) {
      const sym = decodeSymbol(clt);
      if (sym < 16) {
        lens[i++] = sym;
      } else if (sym === 16) {
        const prev = lens[i - 1];
        const rep  = readBits(2) + 3;
        for (let k = 0; k < rep; k++) lens[i++] = prev;
      } else if (sym === 17) {
        const rep = readBits(3) + 3;
        i += rep;
      } else {
        const rep = readBits(7) + 11;
        i += rep;
      }
    }

    const lt = buildTree(lens, 0, hlit);
    const dt = buildTree(lens, hlit, hdist);
    inflateBlock(lt, dt);
  }

  // ---- Main decompression loop ----
  let bfinal;
  do {
    bfinal     = readBit();
    const btype = readBits(2);
    if      (btype === 0) inflateStored();
    else if (btype === 1) inflateBlock(FIXED_LT, FIXED_DT);
    else if (btype === 2) inflateDynamic();
    else throw new Error('inflateRaw: reserved block type');
  } while (!bfinal);

  return out.subarray(0, dst);
}

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
    // Deflate (raw) — try native DecompressionStream, fall back to inflateRaw
    const compressedBytes = new Uint8Array(compressedBlob);
    try {
      if (typeof DecompressionStream !== 'undefined') {
        const blob   = new Blob([compressedBytes]);
        const ds     = new DecompressionStream('deflate-raw');
        const stream = blob.stream().pipeThrough(ds);
        return new Response(stream).text();
      }
    } catch (_) {
      // fall through to inflateRaw
    }
    return new TextDecoder('utf-8').decode(inflateRaw(compressedBytes));
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
// Share helpers — pure, module-level, exported for tests
// ============================================================

// LEB128 (unsigned) varint encode into a growing byte array
function varintWrite(arr, n) {
  n = n >>> 0; // treat as unsigned 32-bit
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n !== 0) byte |= 0x80;
    arr.push(byte);
  } while (n !== 0);
}

// LEB128 (unsigned) varint read from Uint8Array at offset pos
// Returns { value, pos } where pos is updated past the varint
function varintRead(bytes, pos) {
  let result = 0, shift = 0;
  while (pos < bytes.length) {
    const byte = bytes[pos++];
    result |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value: result >>> 0, pos };
}

// payload object shape:
//   { v: 1, nick: string, f: [{name, code, year}], t: [idx0,idx1,idx2,idx3], l: [{w, l}] }
// where code = uri.slice('https://boxd.it/'.length) for boxd.it links, else full uri

function buildSharePayload(state, nickname) {
  const nick = (nickname || '').trim();
  const f = (state.films || []).map(film => {
    const uri = film.uri || '';
    const code = uri.startsWith('https://boxd.it/')
      ? uri.slice('https://boxd.it/'.length)
      : uri;
    const yearInt = parseInt(film.year, 10);
    return {
      name: film.name || '',
      code,
      year: isNaN(yearInt) ? 0 : yearInt,
    };
  });
  const t = (state.ranked || []).slice(0, 4).map(Number);
  const matches = (state.log || []).filter(e => e.kind === 'match');
  const l = matches.map(e => ({ w: Number(e.winner), l: Number(e.loser) }));
  return { v: 1, nick, f, t, l };
}

function payloadToState(payload) {
  const films = (payload.f || []).map(fi => {
    const code = fi.code || '';
    const uri = code.indexOf('://') !== -1 ? code : 'https://boxd.it/' + code;
    return {
      name: fi.name,
      year: fi.year > 0 ? String(fi.year) : '',
      uri,
    };
  });
  const log = (payload.l || []).map(e => ({
    kind: 'match',
    winner: e.w,
    loser: e.l,
  }));
  const beatenBy = {};
  for (let i = 0; i < films.length; i++) beatenBy[i] = [];
  return {
    films,
    beatenBy,
    ranked: (payload.t || []).map(Number),
    log,
    phase: 'done',
    round: [],
    nextRound: [],
    current: null,
    comparisonCount: log.length,
    roundNum: 1,
    phaseSize: 0,
  };
}

function serializePayload(payload) {
  const enc = new TextEncoder();
  const filmCount = (payload.f || []).length;
  const idxWidth = filmCount <= 256 ? 1 : 2;

  const arr = [];

  // header
  arr.push(1);        // version
  arr.push(idxWidth); // index width

  // nickname
  const nickBytes = enc.encode(payload.nick || '');
  varintWrite(arr, nickBytes.length);
  for (let i = 0; i < nickBytes.length; i++) arr.push(nickBytes[i]);

  // filmCount
  varintWrite(arr, filmCount);

  // films
  for (const fi of (payload.f || [])) {
    const nameBytes = enc.encode(fi.name || '');
    const codeBytes = enc.encode(fi.code || '');
    varintWrite(arr, nameBytes.length);
    for (let i = 0; i < nameBytes.length; i++) arr.push(nameBytes[i]);
    varintWrite(arr, codeBytes.length);
    for (let i = 0; i < codeBytes.length; i++) arr.push(codeBytes[i]);
    varintWrite(arr, fi.year > 0 ? fi.year : 0);
  }

  // top-4 indices (idxWidth bytes each, little-endian)
  const t = payload.t || [];
  for (let k = 0; k < 4; k++) {
    const idx = t[k] !== undefined ? t[k] : 0;
    arr.push(idx & 0xff);
    if (idxWidth === 2) arr.push((idx >> 8) & 0xff);
  }

  // matches
  const l = payload.l || [];
  varintWrite(arr, l.length);
  for (const e of l) {
    arr.push(e.w & 0xff);
    if (idxWidth === 2) arr.push((e.w >> 8) & 0xff);
    arr.push(e.l & 0xff);
    if (idxWidth === 2) arr.push((e.l >> 8) & 0xff);
  }

  return new Uint8Array(arr);
}

function deserializePayload(bytes) {
  const dec = new TextDecoder();
  let pos = 0;

  const version = bytes[pos++];
  if (version !== 1) throw new Error('Unsupported payload version: ' + version);
  const idxWidth = bytes[pos++];

  // nickname
  let r = varintRead(bytes, pos); pos = r.pos;
  const nickLen = r.value;
  const nick = dec.decode(bytes.slice(pos, pos + nickLen)); pos += nickLen;

  // filmCount
  r = varintRead(bytes, pos); pos = r.pos;
  const filmCount = r.value;

  const f = [];
  for (let i = 0; i < filmCount; i++) {
    r = varintRead(bytes, pos); pos = r.pos;
    const nameLen = r.value;
    const name = dec.decode(bytes.slice(pos, pos + nameLen)); pos += nameLen;

    r = varintRead(bytes, pos); pos = r.pos;
    const codeLen = r.value;
    const code = dec.decode(bytes.slice(pos, pos + codeLen)); pos += codeLen;

    r = varintRead(bytes, pos); pos = r.pos;
    const year = r.value;

    f.push({ name, code, year });
  }

  // top-4 indices
  const t = [];
  for (let k = 0; k < 4; k++) {
    let idx = bytes[pos++];
    if (idxWidth === 2) idx |= bytes[pos++] << 8;
    t.push(idx);
  }

  // matches
  r = varintRead(bytes, pos); pos = r.pos;
  const matchCount = r.value;
  const l = [];
  for (let i = 0; i < matchCount; i++) {
    let w = bytes[pos++];
    if (idxWidth === 2) w |= bytes[pos++] << 8;
    let lv = bytes[pos++];
    if (idxWidth === 2) lv |= bytes[pos++] << 8;
    l.push({ w, l: lv });
  }

  return { v: 1, nick, f, t, l };
}

// base64url (no padding; + / → - _)
function b64urlFromBytes(bytes) {
  // chunked to avoid call stack overflow for large arrays
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function bytesFromB64url(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function encodeShare(payload) {
  const raw = serializePayload(payload);
  let finalBytes;
  let compressed = null;
  if (typeof CompressionStream !== 'undefined') {
    try {
      const blob = new Blob([raw]);
      const cs = new CompressionStream('deflate-raw');
      const stream = blob.stream().pipeThrough(cs);
      const buf = await new Response(stream).arrayBuffer();
      compressed = new Uint8Array(buf);
    } catch (_) {
      // fall through to raw method
    }
  }
  if (compressed !== null) {
    finalBytes = new Uint8Array(1 + compressed.length);
    finalBytes[0] = 0x44; // 'D'
    finalBytes.set(compressed, 1);
  } else {
    finalBytes = new Uint8Array(1 + raw.length);
    finalBytes[0] = 0x52; // 'R'
    finalBytes.set(raw, 1);
  }
  return b64urlFromBytes(finalBytes);
}

async function decodeShare(str) {
  const bytes = bytesFromB64url(str);
  const method = bytes[0];
  const body = bytes.slice(1);
  let raw;
  if (method === 0x44) { // 'D' — deflate-raw
    try {
      if (typeof DecompressionStream !== 'undefined') {
        const blob = new Blob([body]);
        const ds = new DecompressionStream('deflate-raw');
        const stream = blob.stream().pipeThrough(ds);
        const buf = await new Response(stream).arrayBuffer();
        raw = new Uint8Array(buf);
      } else {
        raw = inflateRaw(body);
      }
    } catch (_) {
      raw = inflateRaw(body);
    }
  } else if (method === 0x52) { // 'R' — raw
    raw = body;
  } else {
    throw new Error('Unknown compression method: ' + method);
  }
  return deserializePayload(raw);
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
  let sharedView    = false; // true when viewing someone else's share link
  let sharedNick    = '';    // nick from the decoded payload

  // ---- DOM refs (populated in init) ----
  let elScreens, elUploadZone, elFileInput, elUploadStatus, elUploadError,
      elStartPicking, elProgress, elCardA, elCardB, elResultsList,
      elProgressBar, elProgressFill, elSubProgress, elBracket, elToggleBracket,
      elUndoMatchup, elUndoResults, elToggleFull, elFullRanking,
      elToggleDecisions, elDecisionsBlock;

  let fullVisible        = false;
  let decisionsVisible   = false;
  let decisionsRendered  = false;

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

  // ---- Decisions list (collapsed by default, works in both modes) ----
  function renderDecisions(label) {
    const elDecisionsLabel = document.getElementById('decisions-label');
    const elDecisionsCount = document.getElementById('decisions-count');
    const elDecisionsList  = document.getElementById('decisions-list');

    elDecisionsLabel.textContent = label;

    // Filter log to match events only
    const matches = engine.state.log.filter(e => e.kind === 'match');
    elDecisionsCount.textContent = String(matches.length);

    while (elDecisionsList.firstChild) elDecisionsList.removeChild(elDecisionsList.firstChild);

    const films = engine.state.films;
    // Reverse chronological (latest first)
    for (let i = matches.length - 1; i >= 0; i--) {
      const e = matches[i];
      const winnerName = films[e.winner] ? films[e.winner].name : '?';
      const loserName  = films[e.loser]  ? films[e.loser].name  : '?';

      const li = document.createElement('li');
      li.className = 'decision-row';

      const chose = document.createElement('span');
      chose.className = 'decision-chose';
      chose.textContent = 'Chose ';

      const winner = document.createElement('strong');
      winner.className = 'decision-winner';
      winner.textContent = winnerName;

      const over = document.createElement('span');
      over.className = 'decision-over';
      over.textContent = ' over ';

      const loser = document.createElement('span');
      loser.className = 'decision-loser';
      loser.textContent = loserName;

      li.appendChild(chose);
      li.appendChild(winner);
      li.appendChild(over);
      li.appendChild(loser);
      elDecisionsList.appendChild(li);
    }
    decisionsRendered = true;
  }

  function applyDecisionsVisibility() {
    elDecisionsBlock.hidden = !decisionsVisible;
    elToggleDecisions.setAttribute('aria-expanded', String(decisionsVisible));
    elToggleDecisions.textContent = decisionsVisible ? 'Hide decisions' : 'Show decisions';
    if (decisionsVisible && !decisionsRendered) {
      const label = sharedView ? 'Their decisions' : 'Your decisions';
      renderDecisions(label);
    }
  }

  function toggleDecisions() {
    decisionsVisible = !decisionsVisible;
    applyDecisionsVisibility();
  }

  // ---- Show results (owner and shared modes) ----
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

    // Decisions toggle: only offered when there is at least 1 match in the log
    const matchCount = engine.state.log.filter(e => e.kind === 'match').length;
    decisionsVisible = false;
    decisionsRendered = false;
    if (matchCount > 0) {
      elToggleDecisions.hidden = false;
    } else {
      elToggleDecisions.hidden = true;
    }
    applyDecisionsVisibility();

    // Mode-specific heading and controls
    const elHeading       = document.getElementById('results-heading');
    const elOwnerControls = document.getElementById('results-owner-controls');
    const elMakeOwn       = document.getElementById('btn-make-own');
    const elMakeOwnWrap   = elMakeOwn.parentElement;

    if (sharedView) {
      elHeading.textContent   = sharedNick
        ? sharedNick + '\u2019s Top Four'
        : 'A Letterboxd Top Four';
      elOwnerControls.hidden  = true;
      elMakeOwn.hidden        = false;
      elMakeOwnWrap.hidden    = false;
    } else {
      elHeading.textContent   = 'Your top favorites';
      elOwnerControls.hidden  = false;
      elMakeOwn.hidden        = true;
      elMakeOwnWrap.hidden    = true;
      updateUndoButtons();
    }

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
    elToggleFull        = document.getElementById('btn-toggle-full');
    elFullRanking       = document.getElementById('full-ranking');
    elToggleFull.addEventListener('click', toggleFull);
    elToggleDecisions   = document.getElementById('btn-toggle-decisions');
    elDecisionsBlock    = document.getElementById('decisions-block');
    elToggleDecisions.addEventListener('click', toggleDecisions);

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

    // "Make your own top four" — shown in shared mode, hidden in owner mode
    document.getElementById('btn-make-own').addEventListener('click', () => {
      history.replaceState(null, '', location.pathname);
      sharedView = false;
      engine     = null;
      showScreen('intro');
    });

    // --- Share panel wiring ---
    const elShareToggle = document.getElementById('btn-share-toggle');
    const elSharePanel  = document.getElementById('share-panel');
    const elShareNick   = document.getElementById('share-nickname');
    const elCopyBtn     = document.getElementById('btn-copy-link');
    const elShareWarn   = document.getElementById('share-length-warning');

    // Pre-generate the share link so the copy click can write to the clipboard
    // synchronously within the user gesture. iOS Safari rejects clipboard writes
    // that happen after an `await`, which made copying fail on mobile.
    const copyLabel = elCopyBtn.textContent;
    let shareLink = '';

    async function regenShareLink() {
      if (!engine || !engine.isComplete()) { shareLink = ''; return; }
      const b64 = await encodeShare(buildSharePayload(engine.state, elShareNick.value.trim()));
      shareLink = location.origin + location.pathname + '#r=' + b64;
      elShareWarn.hidden = shareLink.length <= 8000;
    }

    function flashCopyBtn(text) {
      elCopyBtn.textContent = text;
      elCopyBtn.classList.add('copied');
      setTimeout(() => {
        elCopyBtn.textContent = copyLabel;
        elCopyBtn.classList.remove('copied');
      }, 1500);
    }

    function legacyCopy(text) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) {}
      document.body.removeChild(ta);
      return ok;
    }

    elShareToggle.addEventListener('click', () => {
      const expanded = elSharePanel.hidden === false;
      elSharePanel.hidden = expanded;
      elShareToggle.setAttribute('aria-expanded', String(!expanded));
      if (!expanded) regenShareLink(); // opening — prepare the link up front
    });

    // Regenerate when the nickname changes (not in a gesture, so awaiting is fine).
    elShareNick.addEventListener('input', () => { regenShareLink(); });

    elCopyBtn.addEventListener('click', () => {
      if (!engine || !engine.isComplete()) return;

      // The link is normally pre-generated (panel open / nickname input), so we
      // can call writeText synchronously and keep the iOS user-gesture intact.
      if (shareLink && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(shareLink).then(
          () => flashCopyBtn('Copied!'),
          () => flashCopyBtn(legacyCopy(shareLink) ? 'Copied!' : 'Press Ctrl/⌘+C')
        );
        return;
      }
      if (shareLink) {
        flashCopyBtn(legacyCopy(shareLink) ? 'Copied!' : 'Press Ctrl/⌘+C');
        return;
      }
      // Rare: link not ready yet — generate then copy (best effort).
      regenShareLink().then(() => {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          return navigator.clipboard.writeText(shareLink);
        }
        if (!legacyCopy(shareLink)) throw new Error('copy failed');
      }).then(
        () => flashCopyBtn('Copied!'),
        () => flashCopyBtn('Press Ctrl/⌘+C')
      );
    });

    // --- Load a shared payload into the results screen (no localStorage) ---
    function loadSharedPayload(payload) {
      engine     = TournamentEngine.fromState(payloadToState(payload));
      sharedView = true;
      sharedNick = payload.nick || '';
      showResults();
    }

    // --- Hash check / resume (async IIFE, placed last in init) ---
    (async function initHashOrResume() {
      const hash = location.hash;
      if (/^#r=/.test(hash)) {
        try {
          const payload = await decodeShare(hash.slice(3));
          loadSharedPayload(payload);
          return; // DO NOT touch localStorage — viewer’s own saved game is untouched
        } catch (_) {
          // Invalid/corrupt hash — fall through to normal flow
        }
      }
      // Normal resume path
      sharedView = false;
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
    })();

    // A bare #hash change does not reload the page, so re-check when the hash
    // becomes #r=... (e.g. pasting a share link into an already-open tab).
    window.addEventListener('hashchange', () => {
      if (/^#r=/.test(location.hash)) {
        decodeShare(location.hash.slice(3)).then(loadSharedPayload).catch(() => {});
      }
    });
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
  module.exports = {
    parseCSVLine, parseCSV, TournamentEngine,
    varintWrite, varintRead,
    buildSharePayload, payloadToState,
    serializePayload, deserializePayload,
    b64urlFromBytes, bytesFromB64url,
    encodeShare, decodeShare,
    inflateRaw,
  };
}
