#!/usr/bin/env node
'use strict';

// Rename the nickname embedded in a "Letterboxd Top Four" share link.
//
// Usage:
//   node tools/rename-share.js "<share link or #r= blob>" ["New Name"]
//
// - Accepts either a full share URL (…/#r=XXXX) or just the base64url blob.
// - If "New Name" is omitted you'll be prompted (blank keeps the current name;
//   to clear the name entirely, pass an empty string: node … "<link>" "").
// - The new link is printed to stdout; info goes to stderr (so you can pipe it,
//   e.g. `node tools/rename-share.js "<link>" Dima | pbcopy`).

const path = require('path');
const readline = require('readline');
const { decodeShare, encodeShare } = require(path.join(__dirname, '..', 'app.js'));

const DEFAULT_BASE = 'https://dtsykunov.github.io/letterboxd-top-four/';

function parseInput(arg) {
  const s = (arg || '').trim();
  if (!s) return null;
  const i = s.indexOf('#r=');
  if (i !== -1) return { base: s.slice(0, i) || DEFAULT_BASE, blob: s.slice(i + 3).trim() };
  return { base: DEFAULT_BASE, blob: s };
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(res => rl.question(question, a => { rl.close(); res(a); }));
}

async function main() {
  const input = parseInput(process.argv[2]);
  if (!input) {
    console.error('Usage: node tools/rename-share.js "<share link or #r= blob>" ["New Name"]');
    process.exit(1);
  }

  let payload;
  try {
    payload = await decodeShare(input.blob);
  } catch (e) {
    console.error('Could not decode that share string:', e.message);
    process.exit(1);
  }

  console.error(`Current name: ${payload.nick || '(none)'}  |  films: ${payload.f.length}  |  decisions: ${payload.l.length}`);

  // New name: from argv[3] if provided (even ""), otherwise prompt.
  let newName = process.argv[3];
  if (newName === undefined) {
    const ans = await ask('New name (blank = keep current): ');
    newName = ans.trim() === '' ? (payload.nick || '') : ans.trim();
  }
  payload.nick = newName;

  const link = input.base + '#r=' + await encodeShare(payload);
  console.error(`New name: ${payload.nick || '(none)'}`);
  console.log(link);
}

main().catch(e => { console.error(e); process.exit(1); });
