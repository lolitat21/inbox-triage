// Runs the real src/*.gs against a fake Gmail. No Google account needed.
//   node test/run.mjs                 uses src/Config.example.gs
//   node test/run.mjs src/Config.gs   uses your own config
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const configFile = process.argv[2] || path.join(root, 'src/Config.example.gs');

const DAY = 864e5;
const now = Date.now();

// ---------- fakes ----------
function makeGmail() {
  const labels = new Map();
  const label = name => ({ getName: () => name });
  const GmailApp = {
    getUserLabelByName: n => labels.get(n) || null,
    createLabel: n => { const l = label(n); labels.set(n, l); return l; },
    search: () => [],
    moveThreadsToArchive: ts => ts.forEach(t => t.moveToArchive()),
  };
  return GmailApp;
}

function msg({ from, daysAgo = 0, body = '', headers = [], subject = 's' }) {
  const id = Math.random().toString(36).slice(2);
  return { id, headers, getId: () => id, getFrom: () => from, getSubject: () => subject,
           getPlainBody: () => body, getDate: () => new Date(now - daysAgo * DAY) };
}

function thread(...messages) {
  const labels = new Set();
  const t = {
    archived: false, labels, messages,
    getMessages: () => messages,
    getLabels: () => [...labels].map(n => ({ getName: () => n })),
    addLabel: l => labels.add(l.getName()),
    removeLabel: l => labels.delete(l.getName()),
    moveToArchive: () => { t.archived = true; },
    getFirstMessageSubject: () => messages[0].getSubject(),
    getLastMessageDate: () => messages[messages.length - 1].getDate(),
  };
  return t;
}

function load() {
  const ctx = {
    console, Date, Math, JSON, String, Object,
    Logger: { log: () => {} },
    GmailApp: makeGmail(),
    Gmail: { Users: { Messages: { get: (_me, id) => {
      const m = ctx.__messages.get(id);
      return { payload: { headers: m ? m.headers : [] } };
    } } } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {} }) },
    Utilities: { formatDate: d => d.toISOString().slice(0, 10).replace(/-/g, '/') },
    Session: { getScriptTimeZone: () => 'UTC' },
    __messages: new Map(),
  };
  vm.createContext(ctx);
  // const at top level stays in the script's lexical scope, same as Apps Script's
  // shared global. Expose what the tests need.
  const src = fs.readFileSync(configFile, 'utf8') + '\n' + fs.readFileSync(path.join(root, 'src/Code.gs'), 'utf8')
    + '\nglobalThis.CONFIG = CONFIG; globalThis.LABEL = LABEL;';
  vm.runInContext(src, ctx);
  return ctx;
}

const G = load();
const me   = G.CONFIG.MY_ADDRESSES[0];
const team = 'colleague@' + G.CONFIG.TEAM_DOMAINS[0];
const reg  = (...ms) => { ms.forEach(m => G.__messages.set(m.id, m)); return thread(...ms); };

// ---------- cases ----------
const cases = [
  ['teammate stays',                     reg(msg({ from: `A <${team}>` })),                                   'kept',     'Needs Reply'],
  ['own-domain no-reply is archived',    reg(msg({ from: 'notifications@' + G.CONFIG.TEAM_DOMAINS[0] })),      'archived', 'FYI'],
  ['thread you replied in stays',        reg(msg({ from: 'x@stranger.io', daysAgo: 2 }), msg({ from: me, daysAgo: 1 }), msg({ from: 'x@stranger.io' })), 'kept', 'Needs Reply'],
  ['your own note stays',                reg(msg({ from: me })),                                               'kept',     'ai-mine'],
  ['LinkedIn gets its own label',        reg(msg({ from: 'invitations@em.linkedin.com' })),                    'archived', 'LinkedIn'],
  ['substack subdomain is bulk',         reg(msg({ from: 'someone@mail.substack.com' })),                      'archived', 'Promotion'],
  ['List-Unsubscribe header is bulk',    reg(msg({ from: 'hi@randomvendor.com', headers: [{ name: 'List-Unsubscribe', value: '<mailto:u@x>' }] })), 'archived', 'Promotion'],
  ['noreply mid-local-part is caught',   reg(msg({ from: 'businessprofile-noreply@google.com' })),             'archived', 'FYI'],
  ['stranger, one message: left pending',reg(msg({ from: 'Jane <jane@unknownco.com>', body: 'Saw your talk, quick question.' })), 'pending', 'ai-pending'],
  ['quiet teammate thread is archived',  reg(msg({ from: team, daysAgo: G.CONFIG.KEEP_DAYS + 5 })),            'archived', 'Needs Reply'],
  ['"news" in a real name is not noreply', reg(msg({ from: 'newsom@unknownco.com' })),                         'pending',  'ai-pending'],
];

let pass = 0;
for (const [name, t, outcome, label] of cases) {
  try {
    const got = G.processThread(t);
    assert.equal(got, outcome, `${name}: outcome`);
    assert.ok(t.labels.has(label), `${name}: expected label "${label}", got [${[...t.labels]}]`);
    assert.equal(t.archived, outcome === 'archived', `${name}: archive state`);
    if (outcome !== 'pending') assert.ok(t.labels.has('ai-triaged'), `${name}: ai-triaged`);
    else assert.ok(!t.labels.has('ai-triaged'), `${name}: pending must NOT be ai-triaged`);
    pass++; console.log('  ok  ', name);
  } catch (e) { console.log('  FAIL', e.message); }
}

// A thread that throws is never stamped ai-triaged: pending first, failed second.
{
  const t = reg(msg({ from: 'x@y.com' }));
  G.recordFailure(t);
  const first = t.labels.has('ai-pending') && !t.labels.has('ai-triaged');
  G.recordFailure(t);
  const second = t.labels.has('ai-failed') && !t.labels.has('ai-pending') && !t.labels.has('ai-triaged');
  if (first && second) { pass++; console.log('  ok   failures are never stamped ai-triaged'); }
  else console.log('  FAIL failure path', [...t.labels]);
}

// Stale sweep judges by the LAST message, not Gmail's any-message before:.
{
  const old  = reg(msg({ from: team, daysAgo: 60 }));
  const live = reg(msg({ from: team, daysAgo: 60 }), msg({ from: me, daysAgo: 0 }));
  let served = false;
  G.GmailApp.search = (q) => (!served && q.includes('Needs Reply') ? (served = true, [old, live]) : []);
  const n = G.archiveStaleKept(5000);
  if (n === 1 && old.archived && !live.archived) { pass++; console.log('  ok   stale sweep spares a long thread with a fresh reply'); }
  else console.log('  FAIL stale sweep', n, old.archived, live.archived);
}

const total = cases.length + 2;
console.log(`\n${pass}/${total} passed  (config: ${path.relative(root, configFile)})`);
process.exit(pass === total ? 0 : 1);
