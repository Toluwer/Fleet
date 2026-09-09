'use strict';

/**
 * signup.js — Roblox account creation support.
 *
 * Roblox gates programmatic signup behind browser-side anti-bot checks, so
 * the account creator works through Roblox's real signup page in a Tauri
 * webview — the same proven approach the sign-in flow uses. The Rust shell
 * opens that page with the form pre-filled, and the new session is imported
 * the moment Roblox sets it.
 *
 * This module owns everything that can be checked before that window opens:
 *   - local validation of username / password / birthday / gender
 *   - live username availability through Roblox's public validate endpoint
 */

let logger = { info() {}, warn() {}, error() {} };

function configure(opts) {
  if (opts && opts.logger) logger = opts.logger;
}

/* ----------------------------- Local rules ----------------------------- */

const USERNAME_MIN = 3, USERNAME_MAX = 20;
const PASSWORD_MIN = 8, PASSWORD_MAX = 20;
const MIN_AGE = 13;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const GENDERS = ['Male', 'Female', 'Skip'];

/** Roblox usernames: 3-20 chars, ASCII letters, digits, underscore. */
function validateUsernameLocal(username) {
  const name = String(username || '').trim();
  if (!name) return { ok: false, message: 'Enter a username.' };
  if (name.length < USERNAME_MIN) return { ok: false, message: `At least ${USERNAME_MIN} characters.` };
  if (name.length > USERNAME_MAX) return { ok: false, message: `At most ${USERNAME_MAX} characters.` };
  if (!/^[A-Za-z0-9_]+$/.test(name)) return { ok: false, message: 'Only letters, numbers and underscores.' };
  return { ok: true, message: '' };
}

/** Roblox passwords: 8-20 chars, at least one letter and one number. */
function validatePasswordLocal(password) {
  const pass = String(password || '');
  if (!pass) return { ok: false, message: 'Enter a password.' };
  if (pass.length < PASSWORD_MIN) return { ok: false, message: `At least ${PASSWORD_MIN} characters.` };
  if (pass.length > PASSWORD_MAX) return { ok: false, message: `At most ${PASSWORD_MAX} characters.` };
  if (!/[A-Za-z]/.test(pass) || !/[0-9]/.test(pass)) return { ok: false, message: 'Include at least one letter and one number.' };
  return { ok: true, message: '' };
}

/**
 * Birthday as "YYYY-MM-DD": a real calendar date, not in the future, and at
 * least MIN_AGE years old. (Younger signups route Roblox into a parent-email
 * flow that cannot complete inside the quick-create window.)
 */
function validateBirthdayLocal(birthday) {
  const raw = String(birthday || '').trim();
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return { ok: false, message: 'Pick a valid birthday.' };
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return { ok: false, message: 'That date does not exist.' };
  }
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (date.getTime() > todayUtc) return { ok: false, message: 'The birthday is in the future.' };
  // Age in whole years at the current date.
  let age = now.getUTCFullYear() - year;
  const beforeBirthday = now.getUTCMonth() < month - 1
    || (now.getUTCMonth() === month - 1 && now.getUTCDate() < day);
  if (beforeBirthday) age -= 1;
  if (age < MIN_AGE) return { ok: false, message: `Roblox needs age ${MIN_AGE}+ for this flow — use a different birthday.` };
  if (year < 1900) return { ok: false, message: 'Pick a year Roblox offers (1900 or later).' };
  return { ok: true, message: '', age };
}

function validateGenderLocal(gender) {
  return GENDERS.includes(String(gender || '')) ? { ok: true, message: '' }
    : { ok: false, message: 'Choose Male, Female or Skip.' };
}

/** Full local validation. Returns { ok, errors: { field: message } }. */
function validateInput(input) {
  const inp = input || {};
  const errors = {};
  const u = validateUsernameLocal(inp.username); if (!u.ok) errors.username = u.message;
  const p = validatePasswordLocal(inp.password); if (!p.ok) errors.password = p.message;
  if (inp.confirm !== undefined && String(inp.password || '') !== String(inp.confirm || '')) {
    errors.confirm = 'The passwords do not match.';
  }
  const b = validateBirthdayLocal(inp.birthday); if (!b.ok) errors.birthday = b.message;
  const g = validateGenderLocal(inp.gender); if (!g.ok) errors.gender = g.message;
  return { ok: Object.keys(errors).length === 0, errors };
}

/* ------------------------- Live availability ------------------------- */

/**
 * Friendly text for the codes Roblox's validate endpoint returns. Unknown
 * codes fall back to the endpoint's own message.
 */
const CODE_MESSAGES = {
  0: 'Username is available',
  1: 'That username is already taken',
  2: 'Usernames can only contain letters, numbers and underscores',
  3: 'That username is too short',
  4: 'That username is too long',
  6: 'That username is not allowed',
};

/**
 * Live username availability via Roblox's public endpoint (the birthday
 * parameter satisfies its anonymous-call requirement). Network hiccups are
 * reported, never thrown — Roblox re-validates at signup anyway.
 * Returns { ok, available, message }.
 */
async function checkUsername(username, birthday) {
  const local = validateUsernameLocal(username);
  if (!local.ok) return { ok: true, available: false, message: local.message };
  const bday = validateBirthdayLocal(birthday);
  if (!bday.ok) return { ok: true, available: false, message: 'Pick a valid birthday first.' };
  try {
    const url = 'https://auth.roblox.com/v1/usernames/validate?username='
      + encodeURIComponent(String(username).trim())
      + '&birthday=' + encodeURIComponent(String(birthday).trim());
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Fleet', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 429) return { ok: true, available: null, message: 'Roblox is rate-limiting checks — it will validate the name at sign-up.' };
    if (!res.ok) return { ok: true, available: null, message: 'Could not reach Roblox to check the name — it will be validated at sign-up.' };
    const j = await res.json();
    const code = Number(j && j.code);
    const available = code === 0;
    const message = CODE_MESSAGES[code] || (j && j.message) || (available ? 'Username is available' : 'Roblox rejected that username');
    return { ok: true, available, message };
  } catch (err) {
    logger.warn('Username check failed', (err && err.message) || err);
    return { ok: true, available: null, message: 'Could not reach Roblox to check the name — it will be validated at sign-up.' };
  }
}

/** Birthday "1995-06-15" -> select values Roblox's form uses: Jun / 15 / 1995. */
function birthdayToFormValues(birthday) {
  const b = validateBirthdayLocal(birthday);
  if (!b.ok) return null;
  const m = String(birthday).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const month = Number(m[2]), day = Number(m[3]);
  return { month: MONTHS[month - 1], day: String(day).padStart(2, '0'), year: m[1] };
}

/* ------------------------- Password generator ------------------------- */

/**
 * Random int in [0, n) — crypto-quality when available (Node 20 and modern
 * webviews always have globalThis.crypto), Math.random as a last resort.
 * Rejection sampling keeps the distribution even.
 */
function randomInt(n) {
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') {
    const limit = Math.floor(0x100000000 / n) * n;
    const buf = new Uint32Array(1);
    do { c.getRandomValues(buf); } while (buf[0] >= limit);
    return buf[0] % n;
  }
  return Math.floor(Math.random() * n);
}

// Unambiguous glyphs only — no 0/O, 1/I/l — so the password reads back by eye.
const PASSWORD_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
const PASSWORD_DIGITS = '23456789';

/**
 * A Roblox-legal password: 8-20 characters with at least one letter and one
 * digit (two letters + one digit are seeded first so the rule always holds,
 * then the pool fills the rest and a Fisher-Yates shuffle spreads them).
 */
function generatePassword(length) {
  const len = Math.min(Math.max(Number(length) || 14, PASSWORD_MIN), PASSWORD_MAX);
  const pick = (set) => set[randomInt(set.length)];
  const chars = [pick(PASSWORD_LETTERS), pick(PASSWORD_LETTERS), pick(PASSWORD_DIGITS)];
  const pool = PASSWORD_LETTERS + PASSWORD_DIGITS;
  while (chars.length < len) chars.push(pick(pool));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    const tmp = chars[i]; chars[i] = chars[j]; chars[j] = tmp;
  }
  return chars.join('');
}

/* ------------------------ Username suggestions ------------------------ */

/**
 * Candidate usernames for a taken name: number / underscore suffixes that
 * stay inside Roblox's 3-20 character rule, deduped and never equal to the
 * base name.
 */
function suggestionCandidates(base) {
  const clean = String(base || '').trim();
  const stem = clean.replace(/[^A-Za-z0-9_]/g, '').slice(0, 17);
  const out = [];
  const push = (name) => {
    if (validateUsernameLocal(name).ok && name !== clean && !out.includes(name)) out.push(name);
  };
  if (stem) {
    push(stem + (randomInt(90) + 10));
    push(stem + (randomInt(900) + 100));
    push(stem + '_' + (randomInt(90) + 10));
    push(stem + (randomInt(90) + 10));
    push(stem + '_' + (randomInt(90) + 10));
    push(stem + (randomInt(9000) + 1000));
  }
  return out;
}

/* --------------------------- Batch creation ---------------------------- */

/** Upper bound on one batch: every account still needs its own human check,
 *  so the queue stays inside what a person reasonably wants to solve. */
const BATCH_MAX = 10;

/**
 * Suffix variants for a batch: the stem plus randomized number / underscore
 * endings that stay inside Roblox's 3-20 character rule. Generates enough
 * spares that a few taken names can't starve a full batch.
 */
function batchCandidates(base, want) {
  const clean = String(base || '').trim();
  const stem = clean.replace(/[^A-Za-z0-9_]/g, '').slice(0, 17);
  const out = [];
  const seen = new Set([clean]);
  const push = (name) => {
    if (!seen.has(name) && validateUsernameLocal(name).ok) { seen.add(name); out.push(name); }
  };
  if (stem) {
    const target = Math.max(Number(want) || 1, 1) + 10;
    for (let i = 0; out.length < target && i < 40; i++) {
      push(stem + (randomInt(90) + 10));
      push(stem + '_' + (randomInt(90) + 10));
      push(stem + (randomInt(900) + 100));
      push(stem + (randomInt(9000) + 1000));
    }
  }
  return out;
}

/**
 * Build a batch roster with an injected availability check (so tests can run
 * it without the network). `check` resolves { available: true | false | null };
 * null (rate-limited / unreachable) parks the name in `unverified` instead of
 * discarding it — the caller decides whether to trust those.
 * Returns { ok, requested, names: [available names], unverified: [unknown names] }.
 */
async function batchUsernamesWith(check, base, count) {
  const want = Math.min(Math.max(Number(count) || 1, 1), BATCH_MAX);
  const clean = String(base || '').trim();
  const names = [];
  const unverified = [];
  const checkName = async (name) => {
    let r = null;
    try { r = await check(name); } catch (_) { r = null; }
    if (r && r.available === true) names.push(name);
    else if (!r || r.available !== false) unverified.push(name);
  };
  // The exact name leads the batch when Roblox confirms it free; a taken or
  // unknown base simply means every account rides a verified variant.
  await checkName(clean);
  for (const name of batchCandidates(clean, want)) {
    if (names.length >= want) break;
    await checkName(name);
    await new Promise((resolve) => setTimeout(resolve, 150)); // stay gentle with the endpoint
  }
  return { ok: true, requested: want, names: names.slice(0, want), unverified: unverified.slice(0, want) };
}

/**
 * Verified usernames for a multi-account batch: the base itself when free,
 * then randomized suffix variants checked live against Roblox. Network
 * problems never throw — whatever was verified comes back, plus the names
 * that could not be checked in `unverified`.
 */
async function batchUsernames(base, birthday, count) {
  const bdayOk = validateBirthdayLocal(birthday).ok;
  const bdayStr = bdayOk ? String(birthday).trim() : defaultAdultBirthday();
  return batchUsernamesWith((name) => checkUsername(name, bdayStr), base, count);
}

function defaultAdultBirthday() {
  // 18 years back, "YYYY-MM-DD" — satisfies the validate endpoint's
  // anonymous-call requirement when no valid birthday is at hand.
  const now = new Date();
  return (now.getUTCFullYear() - 18) + '-' + String(now.getUTCMonth() + 1).padStart(2, '0')
    + '-' + String(now.getUTCDate()).padStart(2, '0');
}

/**
 * Check suffix variants of a taken username against Roblox and return up to
 * `count` available ones: { ok, suggestions: [username, ...] }. Network
 * problems never throw — whatever was verified comes back, possibly none.
 */
async function suggestUsernames(base, birthday, count) {
  const want = Math.min(Math.max(Number(count) || 3, 1), 5);
  const candidates = suggestionCandidates(base);
  if (!candidates.length) return { ok: true, suggestions: [] };
  const bdayOk = validateBirthdayLocal(birthday).ok;
  const bdayStr = bdayOk ? String(birthday).trim() : defaultAdultBirthday();
  const suggestions = [];
  for (const name of candidates) {
    if (suggestions.length >= want) break;
    const r = await checkUsername(name, bdayStr);
    if (r && r.available === true) suggestions.push(name);
    await new Promise((resolve) => setTimeout(resolve, 150)); // stay gentle with the endpoint
  }
  return { ok: true, suggestions };
}

module.exports = {
  configure,
  validateInput,
  validateUsernameLocal,
  validatePasswordLocal,
  validateBirthdayLocal,
  validateGenderLocal,
  checkUsername,
  birthdayToFormValues,
  generatePassword,
  randomInt,
  suggestUsernames,
  suggestionCandidates,
  batchUsernames,
  batchUsernamesWith,
  batchCandidates,
  BATCH_MAX,
  GENDERS, MONTHS, USERNAME_MIN, USERNAME_MAX, PASSWORD_MIN, PASSWORD_MAX, MIN_AGE,
};
