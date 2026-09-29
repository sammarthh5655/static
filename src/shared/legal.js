(function () {
/**
 * Static's legal documents.
 *
 * Adapted from the supplied template (browser_legal_framework.md) to say what
 * Static ACTUALLY does. Where the template described things Static does not
 * do - telemetry, crash reporting, sync accounts, end-to-end encrypted cloud
 * storage, SQLite, hash-prefix Safe Browsing lookups - the text says so
 * instead, because a privacy policy that describes a different product is
 * worse than none.
 *
 * Facts only the publisher can supply live in ENTITY. While any is empty the
 * page shows a notice that the documents are not yet complete, and the blanks
 * are shown as blanks, never as invented names or addresses.
 *
 * Update CHANGED and each document's `updated` whenever the text changes.
 */

const ENTITY = {
  company: '',         // legal name of the publisher, e.g. "Static Software Ltd"
  address: '',         // registered postal address
  jurisdiction: '',    // governing law, e.g. "the laws of India"
  privacyEmail: '',    // e.g. privacy@example.com
  securityEmail: '',   // e.g. security@example.com
  supportEmail: '',    // e.g. support@example.com
  liabilityCap: '',    // EULA cap when the software is free, e.g. "USD 10"
  minimumAge: '13',
};

const CHANGED = '2026-09-29';

/** Every outside service Static talks to, and exactly when. */
const DATA_FLOWS = [
  ['Your search engine (Google or Brave Search)', 'What you type in the address bar when you press Enter to search. Nothing is sent while you type: suggestions come from your own history and bookmarks on this device.'],
  ['Google favicon service', 'The domain names of sites shown with an icon on the new tab page, in bookmarks and in tabs (for example "wikipedia.org"), so the icon can be drawn. Not the full address, not the page.'],
  ['Google Gemini', 'Only when you use the assistant: your question, earlier messages in that conversation, and - only if you ask about a page - that page\'s text. A page that looks sensitive (banking, health, sign-in) asks for your permission first, every time.'],
  ['Filter list hosts (GitHub, EasyList)', 'Requests to download ad and tracker blocking lists, about once a day. These are downloads: nothing about you is sent beyond what any download sends (your IP address).'],
  ['Google Translate and Google Lens', 'Only when you choose Translate, Translate selection or Search image: the page address, the selected text, or the image address.'],
  ['Chrome Web Store', 'Only when you browse or install extensions from it.'],
  ['Every website you visit', 'What any browser sends to a website: your IP address, the page you ask for, cookies that site set, and standard browser headers. Shields block known trackers and ads on the way.'],
];

const DOCS = [
  {
    id: 'privacy', title: 'Privacy Policy', group: 'Privacy', updated: CHANGED,
    summary: 'What Static keeps, where, and what ever leaves your device.',
    sections: [
      ['Introduction', [
        'This policy explains how Static ("the Browser", "we", "us") handles information when you use it. Static is published by {company}.',
        'The short version: Static keeps your data on your device. It has no accounts, no sync, no telemetry, no analytics and no crash reporting. Information leaves your device only in the specific cases listed in section 3, each of which you can see and control.',
      ]],
      ['1. What Static stores on your device', [
        'The following is stored in your profile folder on your own device and is never sent to us:',
        '• Browsing history - the pages you visited, with titles and times.',
        '• Bookmarks, notes, reading list, AI conversations, and your settings and themes.',
        '• Cookies, site data, cache and permissions - kept by the Chromium engine, separately for each profile.',
        '• Saved passwords - encrypted with your operating system\'s secure storage (Windows Data Protection or the macOS Keychain) before they are written to disk.',
        '• Blocking statistics - counts of ads and trackers blocked. Counts only, not the pages they were blocked on beyond the current session.',
        'Each profile has its own folder, so one profile cannot read another\'s data. Incognito windows keep everything in memory and in a temporary folder that is deleted when the window closes.',
      ]],
      ['2. What we collect on our servers', [
        'Nothing. Static does not have servers that receive your browsing data. There is no account to sign in to, no synchronisation service, no usage statistics and no automatic crash reporting.',
        'If accounts or sync are offered in future, they will be optional, off by default, described in an update to this policy before they launch, and you will be asked before anything is uploaded.',
      ]],
      ['3. When information leaves your device', [
        'These are the only cases, and what is sent in each:',
        '{flows}',
        'Each of those services handles what it receives under its own privacy policy. We do not receive a copy.',
      ]],
      ['4. Things Static does not do', [
        'Static does not sell or share your personal information. It does not build an advertising profile of you, show you ads, or use your data to train AI models. It does not look up the pages you visit against any remote safety service: its safety checks run on your device.',
      ]],
      ['5. Your choices and controls', [
        'You can view and delete history, cookies, cache and downloads in Settings → Privacy & Security, delete a whole profile in Settings → Profiles, see and delete saved passwords in the password manager, and turn Shields off per site. Choosing Brave Search instead of Google changes where searches go. Not using the assistant means nothing is ever sent to Gemini.',
      ]],
      ['6. Your rights', [
        'Because we hold no personal data about you, a request to access, correct, export or erase data held by us will find none. You can still contact us at {privacyEmail} and we will answer. Your rights under the GDPR, UK GDPR, CCPA/CPRA and LGPD are described in "Your privacy rights".',
      ]],
      ['7. Children', [
        'Static does not collect personal information from anyone, including children. See the Children\'s Privacy Notice.',
      ]],
      ['8. Security', [
        'Static keeps web pages in sandboxed processes separate from the browser itself, encrypts saved passwords with your operating system, and blocks known trackers and malicious hosts. No system is perfectly secure; see the Security Policy for how to report a problem.',
      ]],
      ['9. Changes', [
        'When this policy changes, the date above changes and the new version ships with the update that makes the change. A change that would send more information off your device will be announced in the app before it takes effect.',
      ]],
      ['10. Contact', ['{company}, {address}. Email: {privacyEmail}.']],
    ],
  },
  {
    id: 'rights', title: 'Your privacy rights', group: 'Privacy', updated: CHANGED,
    summary: 'GDPR, UK GDPR, CCPA/CPRA and LGPD, and what they mean for a browser that keeps your data on your device.',
    sections: [
      ['Who is the controller of your data', [
        'For data stored by Static on your device, you are in control: it is on your device and you can delete it at any time. We do not receive it, so we are not processing it.',
        'For data you send to an outside service through Static (a search engine, Google Gemini, a website), that service is responsible for it under its own terms.',
      ]],
      ['EEA and UK (GDPR, UK GDPR)', [
        'You have the rights of access, rectification, erasure, restriction, portability and objection, and the right to complain to your data protection authority. As we hold no personal data about you, these rights are exercised directly on your device (Settings → Privacy & Security and Settings → Profiles). Requests sent to {privacyEmail} will be answered within one month.',
        'Lawful basis: the only processing we could be said to direct is Static\'s own operation on your device, which is necessary to provide the software you chose to use (Article 6(1)(b)). Use of the assistant happens only when you ask for it.',
      ]],
      ['California (CCPA / CPRA)', [
        'We do not sell or share personal information, and we do not use or disclose sensitive personal information. We collect no personal information from California residents, so there is nothing to know, delete, correct or limit; you may still contact {privacyEmail} and we will confirm that in writing. We will not discriminate against anyone for exercising these rights.',
      ]],
      ['Brazil (LGPD)', [
        'You have the rights set out in Article 18 of the LGPD, including confirmation of processing, access, correction, anonymisation, portability and deletion. We confirm that we do not process personal data about you. Contact: {privacyEmail}.',
      ]],
      ['Other places', [
        'Wherever you live, the same applies: your data stays on your device and is yours to keep or delete. Write to {privacyEmail} with any request.',
      ]],
    ],
  },
  {
    id: 'terms', title: 'Terms of Service', group: 'Terms', updated: CHANGED,
    summary: 'The agreement for using Static.',
    sections: [
      ['1. Agreement', [
        'These Terms are an agreement between you and {company} ("we") about your use of Static. By installing or using Static you agree to them. If you do not agree, do not use Static and uninstall it.',
      ]],
      ['2. The software', [
        'Static is a web browser. It lets you visit websites run by others; we are not responsible for their content, availability or practices. Features that rely on outside services (search, the assistant, translation, extensions) are provided by those services and may change or stop.',
      ]],
      ['3. Intellectual property', [
        'Static\'s own code, design, name and logo belong to {company} or its licensors. Static also contains open-source software, which is licensed to you under its own licence; nothing in these Terms limits your rights under those licences. See Open-source licences.',
      ]],
      ['4. Acceptable use', [
        'You agree to follow the Acceptable Use Policy: in short, do not use Static to break the law, harm others, or attack the services it connects to.',
      ]],
      ['5. The assistant', [
        'Answers from the assistant are generated by an AI model and can be wrong. Check anything important against a reliable source. See the AI Usage & Data Policy.',
      ]],
      ['6. Updates and changes', [
        'We may update Static and these Terms. The date above shows the current version; continuing to use Static after an update means you accept the updated Terms.',
      ]],
      ['7. Termination', [
        'You can stop using Static at any time by uninstalling it. We may stop providing any online feature attached to Static, for anyone who breaches these Terms or for any other reason, without liability.',
      ]],
      ['8. Disclaimers and liability', [
        'Static is provided as described in the End User License Agreement, including its disclaimer of warranties and limitation of liability. Nothing in these Terms limits liability that cannot be limited by law.',
      ]],
      ['9. Governing law', ['These Terms are governed by {jurisdiction}, without regard to conflict-of-law rules. Mandatory consumer protections of the country you live in still apply.']],
      ['10. Contact', ['{company}, {address}. Email: {supportEmail}.']],
    ],
  },
  {
    id: 'eula', title: 'End User License Agreement', group: 'Terms', updated: CHANGED,
    summary: 'Your licence to install and use Static.',
    sections: [
      ['1. Licence grant', [
        '{company} ("Licensor") grants you a revocable, non-exclusive, non-transferable, limited licence to download, install and use Static ("the Software") on devices you own or control, in accordance with this Agreement.',
      ]],
      ['2. Restrictions', [
        'You may not sell, rent, lease or sublicense the Software, or distribute modified copies of it under the Static name or logo. You may not modify, decompile or reverse engineer the Software except to the extent that applicable law, or the licence of an open-source component, allows it - those rights are not limited by this Agreement.',
      ]],
      ['3. Open-source components', [
        'Parts of the Software are open source and are licensed to you under their own terms (listed under Open-source licences). Where this Agreement and an open-source licence conflict for that component, the open-source licence governs.',
      ]],
      ['4. Disclaimer of warranties', [
        'THE SOFTWARE IS PROVIDED "AS IS" AND "AS AVAILABLE", WITH ALL FAULTS AND WITHOUT WARRANTY OF ANY KIND. TO THE MAXIMUM EXTENT PERMITTED BY LAW, LICENSOR DISCLAIMS ALL WARRANTIES, EXPRESS, IMPLIED OR STATUTORY, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE AND NON-INFRINGEMENT, AND DOES NOT WARRANT THAT THE SOFTWARE WILL MEET YOUR REQUIREMENTS OR OPERATE WITHOUT INTERRUPTION OR ERROR.',
      ]],
      ['5. Limitation of liability', [
        'TO THE MAXIMUM EXTENT PERMITTED BY LAW, LICENSOR\'S TOTAL LIABILITY UNDER THIS AGREEMENT IS LIMITED TO THE AMOUNT YOU PAID FOR THE SOFTWARE, OR {liabilityCap} IF YOU PAID NOTHING, AND LICENSOR IS NOT LIABLE FOR ANY SPECIAL, INCIDENTAL, INDIRECT OR CONSEQUENTIAL DAMAGES, INCLUDING LOSS OF PROFITS, DATA OR BUSINESS, ARISING FROM USE OF OR INABILITY TO USE THE SOFTWARE. Some places do not allow these limits; where that is so, they apply only as far as the law allows.',
      ]],
      ['6. Termination', ['This licence ends automatically if you breach it. On termination you must uninstall the Software.']],
      ['7. Governing law', ['This Agreement is governed by {jurisdiction}.']],
    ],
  },
  {
    id: 'acceptable-use', title: 'Acceptable Use Policy', group: 'Terms', updated: CHANGED,
    summary: 'What Static must not be used for.',
    sections: [
      ['Do not use Static to', [
        '• break any law, or help anyone else to;',
        '• distribute malware, run attacks against networks or services, or get into systems you are not allowed into;',
        '• scrape or automate websites in breach of their terms;',
        '• harass, threaten, defraud or impersonate anyone;',
        '• overload or interfere with the services Static uses (filter list hosts, the extension store, the assistant);',
        '• use the assistant to produce content that is illegal or that violates Google\'s Generative AI Prohibited Use Policy.',
      ]],
      ['If this policy is broken', ['We may stop providing online features to anyone who breaks it, and will cooperate with lawful requests from authorities.']],
    ],
  },
  {
    id: 'ai', title: 'AI Usage & Data Policy', group: 'Privacy', updated: CHANGED,
    summary: 'Exactly what the assistant sends, to whom, and when.',
    sections: [
      ['What the assistant is', ['The assistant in Static is powered by Google Gemini, reached through Google\'s API. It only runs when you ask it something.']],
      ['What is sent, and when', [
        '• When you ask a question: your question and the earlier messages in that conversation.',
        '• When you ask about a page (for example "summarise this page"): the text of that page, trimmed to a maximum length. Pages that look sensitive - banking, health, sign-in and payment pages - ask you first, every time.',
        '• Nothing is sent in the background, and nothing is sent from incognito windows unless you use the assistant there.',
      ]],
      ['Who receives it', ['Google receives the request and processes it under the Gemini API terms. We do not receive a copy. Conversations are saved on your device so you can return to them, and you can delete them at any time.']],
      ['Accuracy', ['AI answers can be wrong, out of date or incomplete. Do not rely on them for medical, legal, financial or safety decisions without checking a reliable source.']],
      ['Training', ['Static does not use your conversations to train anything. How Google treats API requests is set out in Google\'s own terms.']],
    ],
  },
  {
    id: 'cookies', title: 'Cookie Policy', group: 'Privacy', updated: CHANGED,
    summary: 'Static sets no cookies of its own. Websites do; here is how you control them.',
    sections: [
      ['Static\'s own cookies', ['Static does not set cookies for itself and has no website cookies to track you with.']],
      ['Cookies set by websites', [
        'Websites you visit set their own cookies, stored in your profile on your device. By default Static blocks third-party cookies (cookies from a site other than the one you are on), which are mostly used for tracking. Incognito windows discard all cookies when closed.',
      ]],
      ['Controls', ['Settings → Privacy & Security lets you clear cookies and site data and choose whether third-party cookies are blocked. Shields can be turned off for a single site if it breaks.']],
    ],
  },
  {
    id: 'retention', title: 'Data Retention Policy', group: 'Privacy', updated: CHANGED,
    summary: 'How long your data is kept, and how to remove it.',
    sections: [
      ['On your device', [
        'Your history, bookmarks, notes, conversations, passwords and settings are kept until you delete them. Blocking statistics are kept as daily counts and pruned automatically. Incognito data is deleted when the window closes. Uninstalling Static and deleting its data folder removes everything.',
      ]],
      ['On our servers', ['We keep nothing, because nothing is sent to us. If you email us, we keep the email only as long as needed to answer it and for any legal obligation.']],
    ],
  },
  {
    id: 'deletion', title: 'Account Deletion & Data Export', group: 'Privacy', updated: CHANGED,
    summary: 'There are no accounts to delete. Your data is already yours.',
    sections: [
      ['Accounts', ['Static has no accounts. There is nothing held about you on a server to delete.']],
      ['Deleting your data', ['Clear history and site data in Settings → Privacy & Security, or delete a whole profile in Settings → Profiles. Deleting a profile removes its folder from your device.']],
      ['Exporting your data', ['Your data is stored as files in your profile folder, which you can copy. Bookmarks and passwords can be exported from their pages where that option is offered.']],
    ],
  },
  {
    id: 'children', title: 'Children\'s Privacy Notice', group: 'Privacy', updated: CHANGED,
    summary: 'Static collects nothing from anyone, including children.',
    sections: [
      ['Our position', [
        'Static does not knowingly collect personal information from children under {minimumAge} (or under 16 in the EEA). In fact it collects no personal information from anyone: there are no accounts, no telemetry and no tracking.',
      ]],
      ['Websites', ['Websites visited in Static may collect information under their own policies. Keeping Shields on blocks known trackers, which we recommend for children\'s profiles.']],
      ['Parents and guardians', ['You can inspect or delete any profile on the device in Settings → Profiles, and lock a profile with a PIN. Questions: {privacyEmail}.']],
    ],
  },
  {
    id: 'security', title: 'Security Policy & Vulnerability Disclosure', group: 'Security', updated: CHANGED,
    summary: 'How Static protects you, and how to report a security problem.',
    sections: [
      ['How Static is built', [
        '• Web pages run in sandboxed renderer processes with no access to your files or to Node.js.',
        '• The browser\'s own interface talks to its core only through a fixed list of messages, and every sender is checked.',
        '• Built-in pages have a strict Content Security Policy.',
        '• Saved passwords are encrypted with your operating system.',
        '• Shields block known trackers, malicious hosts and ads before requests are sent.',
      ]],
      ['Reporting a vulnerability', [
        'If you find a security issue, email {securityEmail} with a description, the steps to reproduce it, and the version of Static (Help → About). Please do not publish it until we have released a fix or 90 days have passed, whichever is first.',
        'We will acknowledge your report within 5 working days, keep you informed, and credit you in the release notes if you wish. We will not take legal action against research carried out in good faith, within this policy, that does not harm users or their data.',
      ]],
      ['Out of scope', ['Problems in websites you visit, in third-party extensions, or in outside services Static connects to; social engineering; denial of service.']],
    ],
  },
  {
    id: 'accessibility', title: 'Accessibility Statement', group: 'About', updated: CHANGED,
    summary: 'What works today, and how to tell us what does not.',
    sections: [
      ['What Static supports', [
        '• Keyboard shortcuts for every common action, and keyboard access to menus and settings.',
        '• A "Reduce motion" setting that turns off interface animation, and respect for the system reduced-motion preference.',
        '• Adjustable text size, typeface and density, and page zoom from 25% to 500%.',
        '• Light and dark planets with body text at a contrast ratio of at least 7:1.',
      ]],
      ['Known limits', ['Some newer parts of the interface have not yet been fully tested with screen readers. We are working towards WCAG 2.2 AA.']],
      ['Feedback', ['Tell us about any barrier through Help → Send feedback, or {supportEmail}.']],
    ],
  },
  {
    id: 'law-enforcement', title: 'Law Enforcement & Transparency', group: 'Privacy', updated: CHANGED,
    summary: 'We hold no user data, so there is none to hand over.',
    sections: [
      ['Requests from authorities', [
        'Static stores your data on your device, not with us. We therefore have no browsing history, messages or other user content to disclose. We will answer valid legal requests truthfully, which in almost every case means confirming that we hold no such data. We will tell affected users about a request where the law allows.',
      ]],
      ['Transparency report', ['Requests received to date: 0. This figure will be updated in each release if that changes.']],
    ],
  },
  {
    id: 'dpa', title: 'Data Processing Addendum', group: 'Terms', updated: CHANGED,
    summary: 'For organisations deploying Static.',
    sections: [
      ['Scope', [
        'Organisations that deploy Static to their staff sometimes need a data processing agreement. Because Static processes no personal data on our systems on anyone\'s behalf, we do not act as a processor for your organisation\'s data, and no processing agreement is needed for Static itself.',
        'If you need written confirmation of this for your records, contact {privacyEmail}. If we introduce online services, this addendum will set out the processing terms (subject matter, duration, security measures, sub-processors, and assistance with data subject requests) before they launch.',
      ]],
    ],
  },
  {
    id: 'notices', title: 'Copyright & Trademark', group: 'About', updated: CHANGED,
    summary: 'Who owns what.',
    sections: [
      ['Copyright', ['Copyright © 2026 {company}. All rights reserved, except for open-source components, which remain the property of their authors and are licensed under their own terms.']],
      ['Trademarks', ['"Static" and the Static logo are trademarks of {company}. Chrome and Chromium are trademarks of Google LLC. Other names belong to their owners. Their use does not imply endorsement.']],
      ['Wallpapers', ['Built-in wallpapers are photographs from Unsplash, Pexels and Pixabay, used under those sites\' licences; each photographer is credited on the licences page.']],
    ],
  },
  {
    id: 'contact', title: 'Contact & Support', group: 'About', updated: CHANGED,
    summary: 'How to reach us.',
    sections: [
      ['Support', ['Use Help → Send feedback in Static, or email {supportEmail}.']],
      ['Privacy', ['{privacyEmail}']],
      ['Security', ['{securityEmail} - see the Security Policy.']],
      ['Postal address', ['{company}, {address}']],
    ],
  },
];

/** The blanks still to fill in, so the page can say so plainly. */
function missing() {
  return Object.entries(ENTITY).filter(([, value]) => !value).map(([key]) => key);
}

const shared = { ENTITY, CHANGED, DATA_FLOWS, DOCS, missing };
if (typeof module !== 'undefined' && module.exports) module.exports = shared;
if (typeof window !== 'undefined') window.legal = shared;
})();
