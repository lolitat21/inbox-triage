/**
 * ============================================================
 *  inbox-triage: Gmail triage with rules only.
 *
 *  Goal: the inbox holds only
 *    (a) real people waiting on a reply from you, and
 *    (b) your teammates.
 *  Everything else is labelled and archived, still searchable.
 *
 *  No API key. No network calls. No balance to run dry.
 *  A thread the rules can't call is labelled ai-pending and LEFT IN THE
 *  INBOX, because an unread email from a stranger belongs there.
 *  ai-triaged is applied on success only, so nothing is ever silently buried.
 *
 *  Settings live in Config.gs (copy Config.example.gs).
 * ============================================================
 */

const LABEL = {
  NEEDS_REPLY : 'Needs Reply',
  FYI         : 'FYI',
  PROMOTION   : 'Promotion',
  LINKEDIN    : 'LinkedIn',
  PROCESSED   : 'ai-triaged',   // success only
  PENDING     : 'ai-pending',   // the rules couldn't call it; stays in the inbox
  FAILED      : 'ai-failed',    // threw twice, needs a look
  MINE        : 'ai-mine',      // sent from one of your own addresses
};

const MAX_RUNTIME_MS  = 4 * 60 * 1000;   // bail before Apps Script's 6-minute limit
const STALE_SWEEP_MS  = 30 * 1000;       // per-run budget for archiving quiet kept threads


// ===================== MAIN =====================

function triageInbox() {
  const started = Date.now();
  const props   = PropertiesService.getScriptProperties();

  // A kept thread is stamped ai-triaged, so triage never looks at it again.
  // This sweep is what makes KEEP_DAYS true: it archives kept threads that
  // have gone quiet. Without it the inbox only ever grows.
  const staled   = archiveStaleKept(STALE_SWEEP_MS);
  const promoted = promoteRepliedPending();

  const query = `in:inbox -label:${LABEL.PROCESSED} -label:${LABEL.PENDING} -label:${LABEL.FAILED}`;
  const threads = GmailApp.search(query, 0, CONFIG.MAX_PER_RUN);

  let archived = 0, kept = 0, pending = 0, failed = 0;

  for (const thread of threads) {
    if (Date.now() - started > MAX_RUNTIME_MS) {
      Logger.log('Runtime guard hit. Remaining threads go next run.');
      break;
    }
    try {
      const outcome = processThread(thread);
      if      (outcome === 'pending') pending++;
      else if (outcome === 'kept')    kept++;
      else                            archived++;
    } catch (err) {
      failed++;
      Logger.log(`Error on "${safeSubject(thread)}": ${err.message}`);
      recordFailure(thread);
    }
  }

  props.setProperty('lastRunAt', new Date().toISOString());
  Logger.log(`Done. archived=${archived} kept=${kept} pending=${pending} failed=${failed}`
    + ` promoted=${promoted} staled=${staled}`);
}


/**
 * A pending thread you have since replied to is, by definition, a live
 * conversation. Move it out of the pending pile.
 */
function promoteRepliedPending() {
  if (!GmailApp.getUserLabelByName(LABEL.PENDING)) return 0;

  const threads = GmailApp.search(`in:inbox label:${LABEL.PENDING}`, 0, CONFIG.PENDING_SWEEP);
  let promoted = 0;

  threads.forEach(t => {
    if (!t.getMessages().some(m => isMe(extractEmail(m.getFrom())))) return;
    removeLabel(t, LABEL.PENDING);
    applyLabel(t, LABEL.NEEDS_REPLY);
    applyLabel(t, LABEL.PROCESSED);
    promoted++;
  });

  return promoted;
}


// ===================== PER-THREAD =====================
// Returns 'kept' | 'archived' | 'pending'

function processThread(thread) {
  const messages = thread.getMessages();
  const latest   = messages[messages.length - 1];
  const subject  = latest.getSubject();
  const body     = latest.getPlainBody();
  const sender   = extractEmail(latest.getFrom());

  const route = CONFIG.ROUTES[sender];
  if (route) {
    Logger.log(`"${subject}" -> route "${route.label}"`);
    handleRoute(thread, route, subject, body, latest.getDate());
    return 'archived';
  }

  const ruled = ruleClassify({ messages, sender, body, latest });

  if (!ruled) {
    Logger.log(`"${subject}" [${sender}] -> ai-pending (no rule matched)`);
    applyLabel(thread, LABEL.PENDING);
    return 'pending';
  }

  Logger.log(`"${subject}" [${sender}] -> ${ruled.category}: ${ruled.reason}`);
  return applyClassification(thread, ruled);
}


// ===================== RULES =====================
// Returns {category, reason}, or null when it genuinely cannot tell.
// Order matters: every keep rule runs before any archive rule.

function ruleClassify({ messages, sender, body, latest }) {
  const domain = sender.split('@')[1] || '';
  const local  = sender.split('@')[0] || '';
  const recent = (Date.now() - latest.getDate().getTime()) < CONFIG.KEEP_DAYS * 864e5;

  // --- KEEP ---

  // Mail to yourself is a notes habit. Leave it alone.
  if (isMe(sender)) {
    return recent
      ? { category: 'mine',       reason: 'Sent from your own address.' }
      : { category: 'stale_mine', reason: `Your own thread, quiet ${CONFIG.KEEP_DAYS}+ days.` };
  }

  if (CONFIG.VIP_SENDERS.map(s => s.toLowerCase()).indexOf(sender) !== -1) {
    return { category: 'needs_reply', reason: 'VIP sender.' };
  }

  // Teammates, but not your own company's automated notifications.
  if (matchesDomain(domain, CONFIG.TEAM_DOMAINS)) {
    if (isNoReplyLocalPart(local)) {
      return { category: 'fyi', reason: 'Automated notification from your own domain.' };
    }
    return recent
      ? { category: 'needs_reply', reason: 'Teammate.' }
      : { category: 'stale_reply', reason: `Teammate thread, quiet ${CONFIG.KEEP_DAYS}+ days.` };
  }

  // A conversation you have already replied in is a live conversation.
  if (messages.some(m => isMe(extractEmail(m.getFrom())))) {
    return recent
      ? { category: 'needs_reply', reason: 'You have replied in this thread.' }
      : { category: 'stale_reply', reason: `You replied, but it has been quiet ${CONFIG.KEEP_DAYS}+ days.` };
  }

  // --- ARCHIVE ---

  if (matchesDomain(domain, CONFIG.ALWAYS_ARCHIVE_DOMAINS)) {
    return {
      category: matchesDomain(domain, CONFIG.SOCIAL_LABEL_DOMAINS) ? 'linkedin' : 'promotion',
      reason  : `Known bulk sender (${domain}).`,
    };
  }

  // Bulk mail announces itself with a List-Unsubscribe header.
  if (isBulkMail(latest, body)) {
    return { category: 'promotion', reason: 'Bulk mail (unsubscribe header).' };
  }

  if (isNoReplyLocalPart(local)) {
    return { category: 'fyi', reason: `Automated sender (${local}@).` };
  }

  // A person you have never written to, no unsubscribe header. Could be a
  // real intro, could be cold outreach. Not the script's call.
  return null;
}

/**
 * Matches the automation marker anywhere in the local part, not only at the
 * start. Anchoring to ^ misses businessprofile-noreply@, updates-noreply@,
 * editors-noreply@, groups-noreply@ and messaging-digest-noreply@.
 */
function isNoReplyLocalPart(local) {
  return /(^|[-._])(no-?reply|do-?not-?reply|notifications?|notify|newsletters?|news|updates?|mailer|bounce|alerts?|automated|auto|postmaster|invoice|billing|payments?|receipts?|statements?|failed-payments)([-._+]|$)/i
    .test(local);
}

/** True if the message carries a List-Unsubscribe / List-Id / bulk Precedence header. */
function isBulkMail(message, body) {
  try {
    const meta = Gmail.Users.Messages.get('me', message.getId(), {
      format: 'metadata',
      metadataHeaders: ['List-Unsubscribe', 'List-Id', 'Precedence'],
    });
    const headers = (meta.payload && meta.payload.headers) || [];
    for (const h of headers) {
      const n = h.name.toLowerCase();
      if (n === 'list-unsubscribe' || n === 'list-id') return true;
      if (n === 'precedence' && /bulk|list/i.test(h.value)) return true;
    }
    return false;
  } catch (e) {
    // Advanced Gmail service not enabled: fall back to scanning the footer.
    const tail = (body || '').slice(-1500).toLowerCase();
    return tail.indexOf('unsubscribe') !== -1
        || tail.indexOf('manage preferences') !== -1
        || tail.indexOf('email preferences') !== -1;
  }
}


// ===================== APPLY =====================

function applyClassification(thread, { category }) {
  switch (category) {
    case 'mine':
      applyLabel(thread, LABEL.MINE);
      markProcessed(thread);
      return 'kept';

    case 'needs_reply':
      applyLabel(thread, LABEL.NEEDS_REPLY);
      markProcessed(thread);
      return 'kept';

    case 'stale_reply': applyLabel(thread, LABEL.NEEDS_REPLY); break;  // labelled, then archived
    case 'stale_mine':  applyLabel(thread, LABEL.MINE);        break;  // labelled, then archived
    case 'linkedin':    applyLabel(thread, LABEL.LINKEDIN);    break;
    case 'promotion':   applyLabel(thread, LABEL.PROMOTION);   break;
    default:            applyLabel(thread, LABEL.FYI);         break;
  }

  thread.moveToArchive();
  markProcessed(thread);
  return 'archived';
}

function markProcessed(thread) {
  applyLabel(thread, LABEL.PROCESSED);
  removeLabel(thread, LABEL.PENDING);
}

/** A thread that threw is NEVER marked ai-triaged. First failure parks it, second flags it. */
function recordFailure(thread) {
  if (hasLabel(thread, LABEL.PENDING)) {
    removeLabel(thread, LABEL.PENDING);
    applyLabel(thread, LABEL.FAILED);
    Logger.log(`  second failure: marked ${LABEL.FAILED}, left in inbox.`);
  } else {
    applyLabel(thread, LABEL.PENDING);
    Logger.log('  parked as pending, will retry next run.');
  }
}


// ===================== ROUTES =====================

function handleRoute(thread, route, subject, body, date) {
  applyLabel(thread, route.label);
  if (route.driveFolderId) saveToFolder(route.driveFolderId, subject, body, date);
  thread.moveToArchive();
  markProcessed(thread);
}

function saveToFolder(folderId, subject, body, date) {
  const folder   = DriveApp.getFolderById(folderId);
  const dateStr  = Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const fileName = `${dateStr} ${subject.replace(/[^\w\s-]/g, '').trim()}`;
  folder.createFile(fileName + '.txt',
    `Subject: ${subject}\nDate: ${date}\n\n${body}`, MimeType.PLAIN_TEXT);
}


// ===================== HELPERS =====================

function isMe(email) {
  return CONFIG.MY_ADDRESSES.map(a => a.toLowerCase()).indexOf(email) !== -1;
}

function matchesDomain(domain, list) {
  return list.some(d => domain === d || domain.endsWith('.' + d));
}

function applyLabel(thread, name) {
  let label = GmailApp.getUserLabelByName(name);
  if (!label) label = GmailApp.createLabel(name);
  thread.addLabel(label);
}

function removeLabel(thread, name) {
  const label = GmailApp.getUserLabelByName(name);
  if (label) { try { thread.removeLabel(label); } catch (e) {} }
}

function hasLabel(thread, name) {
  return thread.getLabels().some(l => l.getName() === name);
}

function extractEmail(from) {
  const match = from.match(/<(.+?)>/);
  return (match ? match[1] : from).toLowerCase().trim();
}

function safeSubject(thread) {
  try { return thread.getFirstMessageSubject(); } catch (e) { return '(no subject)'; }
}

function protectedGuard() {
  return ' -is:starred' + CONFIG.PROTECTED_LABELS.map(l => ` -label:"${l}"`).join('');
}


// ===================== HOUSEKEEPING =====================

/**
 * Archives kept threads (Needs Reply, ai-mine) that have been quiet for
 * KEEP_DAYS+, label intact. Starred and protected-label threads are never
 * touched. Runs inside triageInbox; run it by hand after lowering KEEP_DAYS.
 */
function archiveStaleKept(budgetMs) {
  const started  = Date.now();
  const cutoffMs = Date.now() - CONFIG.KEEP_DAYS * 864e5;
  const cutoff   = Utilities.formatDate(new Date(cutoffMs), Session.getScriptTimeZone(), 'yyyy/MM/dd');

  const queries = [
    `in:inbox label:"${LABEL.NEEDS_REPLY}" before:${cutoff}`,
    `in:inbox label:${LABEL.MINE} before:${cutoff}`,
  ];

  let archived = 0;
  for (const q of queries) {
    let start = 0;
    while (Date.now() - started < (budgetMs || MAX_RUNTIME_MS)) {
      const batch = GmailApp.search(q + protectedGuard(), start, 100);
      if (batch.length === 0) break;
      // Gmail's before: matches a thread if ANY message is old, so a long
      // thread with a reply this morning still comes back. Judge by the
      // last message, and step past the live ones.
      const stale = batch.filter(t => t.getLastMessageDate().getTime() < cutoffMs);
      if (stale.length) GmailApp.moveThreadsToArchive(stale);
      archived += stale.length;
      if (batch.length < 100) break;
      start += batch.length - stale.length;
    }
  }
  return archived;
}

/** Clears ai-failed so those threads get another chance. */
function retryFailed() {
  const label = GmailApp.getUserLabelByName(LABEL.FAILED);
  if (!label) { Logger.log('Nothing failed.'); return; }
  const threads = label.getThreads(0, 200);
  threads.forEach(t => t.removeLabel(label));
  Logger.log(`Cleared ${threads.length} failed thread(s) for retry.`);
}


// ===================== DAY-ONE CLEANUP =====================
// For an inbox that is already thousands deep. Preview first.

const CLEANUP_QUERIES = [
  'in:inbox category:promotions',
  'in:inbox category:social',
  'in:inbox category:forums',
  'in:inbox from:linkedin.com',
];

function cleanupGuard() {
  return protectedGuard()
    + CONFIG.TEAM_DOMAINS.map(d => ` -from:${d}`).join('')
    + ` -label:"${LABEL.NEEDS_REPLY}"`;
}

/** SAFE. Counts what runInboxCleanup() would archive. Changes nothing. */
function previewInboxCleanup() {
  let total = 0;
  CLEANUP_QUERIES.forEach(q => {
    const n = countThreads(q + cleanupGuard());
    total += n;
    Logger.log(`${String(n).padStart(5)}  ${q}`);
  });
  Logger.log(`~${total} threads would be archived (overlaps counted twice).`);
}

/** Archives everything previewInboxCleanup() reported. Reversible: it's all in All Mail. */
function runInboxCleanup() {
  const started = Date.now();
  let archived = 0;
  for (const q of CLEANUP_QUERIES) {
    while (Date.now() - started < MAX_RUNTIME_MS) {
      const batch = GmailApp.search(q + cleanupGuard(), 0, 100);
      if (batch.length === 0) break;
      GmailApp.moveThreadsToArchive(batch);
      archived += batch.length;
    }
  }
  Logger.log(`Archived ${archived} thread(s). Re-run if it hit the time guard.`);
}

function countThreads(query) {
  let total = 0, start = 0;
  while (start < 2000) {
    const batch = GmailApp.search(query, start, 100);
    total += batch.length;
    if (batch.length < 100) break;
    start += 100;
  }
  return total;
}


// ===================== SETUP & HEALTH =====================

/** Creates every label up front so nothing races on the first run. */
function createLabels() {
  Object.keys(LABEL).forEach(k => {
    if (!GmailApp.getUserLabelByName(LABEL[k])) GmailApp.createLabel(LABEL[k]);
  });
  Logger.log('Labels ready.');
}

/** Installs the 15-minute trigger, replacing any existing one. */
function setupTrigger() {
  pauseAutomation();
  ScriptApp.newTrigger('triageInbox').timeBased().everyMinutes(15).create();
  Logger.log('Trigger installed: triageInbox every 15 minutes.');
}

function pauseAutomation() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => ScriptApp.deleteTrigger(t));
  Logger.log(`Removed ${triggers.length} trigger(s).`);
}

/**
 * The one silent failure left is the trigger quietly disappearing,
 * so that is the first thing this reports.
 */
function status() {
  const triggers = ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'triageInbox');

  Logger.log(triggers.length
    ? `Trigger active (${triggers.length}).`
    : 'NO TRIGGER: triage is not running. Run setupTrigger().');

  Logger.log(`Last run    : ${PropertiesService.getScriptProperties().getProperty('lastRunAt') || 'never'}`);
  Logger.log(`Inbox       : ${countThreads('in:inbox')}`);
  Logger.log(`ai-pending  : ${countThreads('in:inbox label:' + LABEL.PENDING)}`);
  Logger.log(`ai-failed   : ${countThreads('in:inbox label:' + LABEL.FAILED)}`);
  Logger.log(`Needs Reply : ${countThreads(`in:inbox label:"${LABEL.NEEDS_REPLY}"`)}`);
}
