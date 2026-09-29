'use strict';

/**
 * Feedback and bug reports.
 *
 * A report is assembled from ONLY what the user left switched on in the form:
 * the description is the one required field, and every piece of diagnostic
 * information is opt-in and shown to them before sending.
 *
 * `transport` is where reports go. Static has no feedback server yet, so the
 * default transport saves each report as a folder on this device that the
 * user can open, attach to an email, or delete. A backend replaces the
 * transport; nothing else here changes.
 */

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const CATEGORIES = [
  { id: 'bug', name: 'Bug report' },
  { id: 'feature', name: 'Feature request' },
  { id: 'design', name: 'UI / UX suggestion' },
  { id: 'performance', name: 'Performance issue' },
  { id: 'crash', name: 'Crash' },
  { id: 'security', name: 'Security issue' },
  { id: 'privacy', name: 'Privacy issue' },
  { id: 'compatibility', name: 'Website compatibility' },
  { id: 'ai', name: 'AI feedback' },
  { id: 'other', name: 'Other' },
];

const MAX_ATTACHMENTS = 8;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Keep only what the user chose, in a shape a server could accept later. */
function buildReport(input, available) {
  const description = String(input?.description || '').trim().slice(0, 20000);
  if (description.length < 5) throw new Error('Please describe the problem or idea first.');
  const category = CATEGORIES.some((c) => c.id === input?.category) ? input.category : 'other';
  const include = input?.include && typeof input.include === 'object' ? input.include : {};
  const report = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    category,
    description,
    contact: String(input?.contact || '').trim().slice(0, 200) || undefined,
    included: {},
  };
  for (const [key, value] of Object.entries(available)) {
    if (include[key] === true && value !== undefined) report.included[key] = value;
  }
  return report;
}

/** Validate attachments: real files, not too many, not too large. */
function checkAttachments(list) {
  const files = (Array.isArray(list) ? list : []).slice(0, MAX_ATTACHMENTS);
  return files.filter((file) => {
    try {
      const stat = fs.statSync(file);
      return stat.isFile() && stat.size <= MAX_ATTACHMENT_BYTES;
    } catch { return false; }
  });
}

/** The default transport: a folder per report on this device. */
function localTransport(root) {
  return async (report, { attachments = [], screenshots = [] } = {}) => {
    const dir = path.join(root, 'feedback', report.createdAt.replace(/[:.]/g, '-') + '-' + report.category);
    fs.mkdirSync(dir, { recursive: true });
    report.attachments = [];
    for (const file of attachments) {
      const name = path.basename(file).replace(/[^\w.\- ]+/g, '_');
      fs.copyFileSync(file, path.join(dir, name));
      report.attachments.push(name);
    }
    screenshots.forEach((png, index) => {
      const name = 'screenshot-' + (index + 1) + '.png';
      fs.writeFileSync(path.join(dir, name), png);
      report.attachments.push(name);
    });
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
    return { saved: true, where: dir };
  };
}

module.exports = { CATEGORIES, buildReport, checkAttachments, localTransport, MAX_ATTACHMENTS };
