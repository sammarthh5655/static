const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, randomBytes, pbkdf2Sync, timingSafeEqual } = require('node:crypto');
const { JsonStore } = require('../../main/storage');

/**
 * User-created browsing identities.
 *
 * WHAT A PROFILE IS
 * A profile is a NAME THE USER CHOSE and a directory of their own. It is not
 * a category: there is no built-in "Work" or "Study" that the browser knows
 * about. Templates exist only as optional starting points, and a profile made
 * from one is indistinguishable afterwards from a profile made from scratch.
 *
 * HOW SEPARATION WORKS
 * Every feature in this browser already takes its storage directory as a
 * constructor argument, so a profile is simply a different directory:
 *
 *     <userData>/profiles/<id>/history.json, notes-store.json, shields.json...
 *
 * Cookies and logins are separated by giving each profile its own Electron
 * session partition, which Chromium keeps in its own directory. That means
 * separation is enforced by the browser engine rather than by our own
 * bookkeeping - there is no way for one profile to read another's cookies
 * because they are not in the same store to begin with.
 *
 * WHAT THIS MODULE DOES NOT DO
 * It does not switch profiles itself. Switching means rebuilding sessions and
 * views, which is the application's job; this module owns the list, the
 * metadata and the directories, and nothing else.
 */

/** Where every profile's directory lives, under userData. */
const PROFILES_DIR = 'profiles';

/** A profile the user has not named yet. */
const FALLBACK_NAME = 'Me';

/** Optional starting points. A profile made from one is not marked by it. */
const TEMPLATES = {
  blank: {
    id: 'blank', name: 'Start blank',
    summary: 'Nothing configured. Everything on its defaults.',
    settings: {},
  },
  minimal: {
    id: 'minimal', name: 'Minimal',
    summary: 'A clock and the search box. Nothing else on the homepage.',
    settings: { newTab: { widgets: ['clock'], showMostVisited: false } },
  },
  productivity: {
    id: 'productivity', name: 'Productivity',
    summary: 'Shortcuts, downloads and recent pages, in a denser layout.',
    settings: { density: 'compact', newTab: { widgets: ['clock', 'shortcuts', 'downloads', 'recent'], showMostVisited: true } },
  },
  privacy: {
    id: 'privacy', name: 'Privacy',
    summary: 'Every shield on, no most-visited row, nothing suggested from history.',
    settings: { newTab: { widgets: ['clock', 'privacy'], showMostVisited: false } },
    shields: {
      enabled: true, blockTrackers: true, upgradeHttps: true, stripTracking: true,
      blockThirdPartyCookies: true, blockVideoAds: true, hideAdSlots: true,
    },
  },
  gaming: {
    id: 'gaming', name: 'Gaming',
    summary: 'Game Mode ready, with resources and downloads in view.',
    settings: { newTab: { widgets: ['clock', 'shortcuts', 'downloads'], showMostVisited: true } },
  },
};

/** When the picker appears at startup. */
const STARTUP_MODES = {
  always: { id: 'always', name: 'Always show the picker' },
  multiple: { id: 'multiple', name: 'Only when more than one profile exists' },
  last: { id: 'last', name: 'Continue with the last profile used' },
  default: { id: 'default', name: 'Always open the default profile' },
};

/** Avatar glyphs offered when there is no image. Kept short and neutral. */
const AVATARS = ['planet', 'star', 'moon', 'comet', 'orbit', 'rocket',
  'leaf', 'flame', 'wave', 'peak', 'key', 'shield'];

/** A name that is safe to show and to store. */
function cleanName(value) {
  const text = String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, 40);
  return text || FALLBACK_NAME;
}

/** PIN hashing. Never store the PIN itself. */
function hashPin(pin, salt) {
  return pbkdf2Sync(String(pin), salt, 120000, 32, 'sha256').toString('hex');
}

class Profiles {
  /**
   * @param {string} root the browser's userData directory
   */
  constructor(root, { onChange = () => {} } = {}) {
    this.root = root;
    this.dir = path.join(root, PROFILES_DIR);
    fs.mkdirSync(this.dir, { recursive: true });

    this.store = new JsonStore(root, 'profiles', {
      list: [],
      activeId: '',
      defaultId: '',
      lastUsedId: '',
      startup: 'multiple',
    });
    this.onChange = onChange;

    // A browser with no profiles cannot start, so the first run makes one.
    // It is named generically and is renamed like any other - it is not
    // special, it just exists so there is somewhere to be.
    if (!this.store.data.list.length) this.create({ name: FALLBACK_NAME });
    if (!this.store.data.defaultId) this.store.data.defaultId = this.store.data.list[0].id;
    if (!this.store.data.activeId) this.store.data.activeId = this.store.data.defaultId;
    this.store.save();
  }

  get list() { return this.store.data.list; }

  get active() {
    return this.list.find((profile) => profile.id === this.store.data.activeId) || this.list[0];
  }

  /** The directory this profile's feature stores live in. */
  directory(id) { return path.join(this.dir, String(id)); }

  /**
   * The Electron session partition for a profile.
   *
   * `persist:` keeps cookies across restarts. A guest profile deliberately
   * does NOT use persist:, so its cookies die with the session.
   */
  partition(id) {
    const profile = this.find(id);
    if (profile && profile.guest) return 'profile-guest-' + id;
    return 'persist:profile-' + id;
  }

  find(id) { return this.list.find((profile) => profile.id === id) || null; }

  /**
   * Create a profile.
   *
   * Only `name` is required, and even that falls back. Everything else is a
   * preference the user can change later.
   */
  create(input = {}) {
    if (this.list.length >= 30) throw new Error('You can have up to 30 profiles.');

    const id = randomUUID();
    const profile = {
      id,
      name: cleanName(input.name),
      // Presentation.
      avatar: AVATARS.includes(input.avatar) ? input.avatar : AVATARS[this.list.length % AVATARS.length],
      emoji: typeof input.emoji === 'string' ? input.emoji.slice(0, 8) : '',
      accent: /^#[0-9a-f]{6}$/i.test(String(input.accent || '')) ? input.accent : '',
      theme: typeof input.theme === 'string' ? input.theme : '',
      label: String(input.label || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 60),
      // Behaviour.
      guest: !!input.guest,
      template: TEMPLATES[input.template] ? input.template : '',
      // Bookkeeping. Times are stamped by the caller's clock so tests can
      // control them.
      createdAt: input.now || Date.now(),
      lastUsedAt: 0,
      // PIN, when set. Only ever a salt and a derived hash.
      pin: null,
    };

    fs.mkdirSync(this.directory(id), { recursive: true });
    this.store.data.list.push(profile);
    if (!this.store.data.defaultId) this.store.data.defaultId = id;
    this.store.save();
    this.onChange();
    return profile;
  }

  /** Change anything about a profile except its id. */
  update(id, patch = {}) {
    const profile = this.find(id);
    if (!profile) throw new Error('That profile no longer exists.');

    if (patch.name !== undefined) profile.name = cleanName(patch.name);
    if (patch.avatar !== undefined && AVATARS.includes(patch.avatar)) profile.avatar = patch.avatar;
    if (patch.emoji !== undefined) profile.emoji = String(patch.emoji).slice(0, 8);
    if (patch.accent !== undefined) {
      profile.accent = /^#[0-9a-f]{6}$/i.test(String(patch.accent)) ? patch.accent : '';
    }
    if (patch.theme !== undefined) profile.theme = String(patch.theme).slice(0, 40);
    if (patch.label !== undefined) {
      profile.label = String(patch.label).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 60);
    }
    this.store.save();
    this.onChange();
    return profile;
  }

  /** Copy a profile's settings, but never its browsing data. */
  duplicate(id, name) {
    const source = this.find(id);
    if (!source) throw new Error('That profile no longer exists.');

    const copy = this.create({
      name: name || source.name + ' copy',
      avatar: source.avatar, emoji: source.emoji,
      accent: source.accent, theme: source.theme,
    });

    // Settings and appearance are copied; history, cookies, notes and
    // passwords are NOT. Duplicating a profile must not duplicate a browsing
    // record the user may have forgotten is there.
    for (const file of ['settings.json']) {
      const from = path.join(this.directory(id), file);
      if (fs.existsSync(from)) {
        try { fs.copyFileSync(from, path.join(this.directory(copy.id), file)); }
        catch { /* a copy that fails leaves a clean default profile */ }
      }
    }
    return copy;
  }

  /**
   * Delete a profile and everything in it.
   *
   * The last profile cannot be deleted: a browser with nowhere to be cannot
   * start, and silently recreating one would be worse than refusing.
   */
  remove(id) {
    // Identity first, then the rule. Checking the count first reported "you
    // need at least one profile" for an id that was never there, which sends
    // whoever reads it looking in the wrong place.
    const profile = this.find(id);
    if (!profile) throw new Error('That profile no longer exists.');
    if (this.list.length <= 1) throw new Error('You need at least one profile.');

    this.store.data.list = this.list.filter((item) => item.id !== id);
    try { fs.rmSync(this.directory(id), { recursive: true, force: true }); }
    catch { /* files in use; the entry is gone either way */ }

    // Never leave a dangling pointer at a profile that no longer exists.
    if (this.store.data.defaultId === id) this.store.data.defaultId = this.list[0].id;
    if (this.store.data.activeId === id) this.store.data.activeId = this.store.data.defaultId;
    if (this.store.data.lastUsedId === id) this.store.data.lastUsedId = '';
    this.store.save();
    this.onChange();
    return true;
  }

  /** Erase a profile's data without removing the profile. */
  clearData(id) {
    const profile = this.find(id);
    if (!profile) throw new Error('That profile no longer exists.');
    const dir = this.directory(id);
    try {
      for (const entry of fs.readdirSync(dir)) {
        fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
      }
    } catch { /* nothing to clear */ }
    this.onChange();
    return true;
  }

  /** Mark a profile as the one in use. */
  setActive(id, now = Date.now()) {
    const profile = this.find(id);
    if (!profile) throw new Error('That profile no longer exists.');
    profile.lastUsedAt = now;
    this.store.data.activeId = id;
    // A guest is deliberately never remembered as "last used": resuming into
    // a guest session would defeat the point of it.
    if (!profile.guest) this.store.data.lastUsedId = id;
    this.store.save();
    this.onChange();
    return profile;
  }

  setDefault(id) {
    if (!this.find(id)) throw new Error('That profile no longer exists.');
    this.store.data.defaultId = id;
    this.store.save();
    this.onChange();
    return true;
  }

  setStartup(mode) {
    if (!STARTUP_MODES[mode]) throw new Error('No such startup setting.');
    this.store.data.startup = mode;
    this.store.save();
    this.onChange();
    return mode;
  }

  /* ---- PIN lock --------------------------------------------------------- */

  /**
   * Set or clear a profile's PIN.
   *
   * This is a convenience lock, not encryption: the profile's files are still
   * on disk and readable by anything with access to the machine. It is worth
   * saying so plainly rather than implying a protection that is not there.
   */
  setPin(id, pin) {
    const profile = this.find(id);
    if (!profile) throw new Error('That profile no longer exists.');

    if (pin === null || pin === undefined || pin === '') {
      profile.pin = null;
      this.store.save();
      this.onChange();
      return true;
    }
    const value = String(pin);
    if (!/^\d{4,12}$/.test(value)) throw new Error('Use a PIN of 4 to 12 digits.');
    const salt = randomBytes(16).toString('hex');
    profile.pin = { salt, hash: hashPin(value, salt) };
    this.store.save();
    this.onChange();
    return true;
  }

  /** Is this the right PIN? Compared in constant time. */
  checkPin(id, pin) {
    const profile = this.find(id);
    if (!profile || !profile.pin) return true;
    try {
      const attempt = Buffer.from(hashPin(String(pin || ''), profile.pin.salt), 'hex');
      const stored = Buffer.from(profile.pin.hash, 'hex');
      return attempt.length === stored.length && timingSafeEqual(attempt, stored);
    } catch { return false; }
  }

  /* ---- startup ---------------------------------------------------------- */

  /** Which profile should open, and should the picker be shown first? */
  startup() {
    const mode = this.store.data.startup;
    const many = this.list.filter((profile) => !profile.guest).length > 1;
    const show =
      mode === 'always' ? true :
      mode === 'multiple' ? many :
      false;

    let id = this.store.data.defaultId;
    if (mode === 'last' && this.store.data.lastUsedId && this.find(this.store.data.lastUsedId)) {
      id = this.store.data.lastUsedId;
    }
    if (!this.find(id)) id = this.list[0].id;
    return { show, id };
  }

  /* ---- state ------------------------------------------------------------ */

  /** One profile, as the picker renders it. Never includes the PIN hash. */
  card(profile, extra = {}) {
    return {
      id: profile.id,
      name: profile.name,
      avatar: profile.avatar,
      emoji: profile.emoji,
      accent: profile.accent,
      theme: profile.theme,
      label: profile.label,
      guest: !!profile.guest,
      locked: !!profile.pin,
      createdAt: profile.createdAt,
      lastUsedAt: profile.lastUsedAt,
      isActive: profile.id === this.store.data.activeId,
      isDefault: profile.id === this.store.data.defaultId,
      ...extra,
    };
  }

  state() {
    return {
      profiles: this.list.map((profile) => this.card(profile)),
      activeId: this.store.data.activeId,
      defaultId: this.store.data.defaultId,
      startup: this.store.data.startup,
      startupModes: Object.values(STARTUP_MODES),
      templates: Object.values(TEMPLATES).map(({ id, name, summary }) => ({ id, name, summary })),
      avatars: [...AVATARS],
    };
  }

  flush() { this.store.save(); }
}

module.exports = { Profiles, TEMPLATES, STARTUP_MODES, AVATARS, cleanName, PROFILES_DIR };
