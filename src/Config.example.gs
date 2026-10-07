/**
 * inbox-triage: your settings.
 *
 * Copy this file to Config.gs and edit it. Config.gs is gitignored, so your
 * address, your team's domain and your routing rules never end up in a commit.
 * In the Apps Script editor, just create a file named Config.gs and paste this in.
 */

const CONFIG = {

  // Every address you send from. A thread you have replied in is a live
  // conversation, and mail from these addresses is yours.
  MY_ADDRESSES: ['you@example.com'],

  // Anyone at these domains (or their subdomains) stays in the inbox.
  TEAM_DOMAINS: ['example.com'],

  // Always kept, whatever else is true about the message.
  VIP_SENDERS: [
    // 'cofounder@example.com',
  ],

  // Always archived, no questions asked. Adding a domain here is the cheapest
  // tuning there is: check the ai-pending pile once a week and add the bulk
  // senders you find in it.
  ALWAYS_ARCHIVE_DOMAINS: [
    // social
    'linkedin.com', 'facebookmail.com', 'instagram.com', 'x.com', 'twitter.com',
    'redditmail.com',
    // newsletter and publishing platforms
    'substack.com', 'beehiiv.com', 'ghost.io', 'medium.com', 'quora.com',
    // event platforms
    'eventbrite.com', 'meetup.com', 'luma-mail.com',
    // media-request services
    'qwoted.com', 'helpareporter.com',
  ],

  // Domains that get the LinkedIn label instead of Promotion when archived.
  SOCIAL_LABEL_DOMAINS: ['linkedin.com'],

  // Labels you use to flag mail for yourself. Nothing carrying one of these
  // (or a star) is ever bulk-archived.
  PROTECTED_LABELS: ['To Do', 'Waiting'],

  // Optional: senders that get their own label, and whose emails are saved as
  // .txt files to a Drive folder before archiving. Good for a newsletter you
  // want to keep as a corpus without it sitting in your inbox.
  ROUTES: {
    // 'writer@substack.com': { label: 'Writer Name', driveFolderId: '1AbC...' },
  },

  KEEP_DAYS: 30,       // a kept thread quiet for longer than this gets archived, label intact
  MAX_PER_RUN: 100,    // threads classified per run
  PENDING_SWEEP: 40,   // ai-pending threads re-checked per run for your reply
};
