'use strict';

/**
 * Tracking protection levels.
 *
 * A level is only a name for a set of switches. The switches are what is in
 * force, so the level shown is READ from them rather than stored beside them:
 * turn one switch by hand and the level is Custom, because that is now true.
 * A stored level could say Strict while a switch said otherwise.
 *
 * Three switches belong to Shields (they predate this and live in its store);
 * the rest are settings. `fingerprinting` is implemented by the fingerprinting
 * protection (another part of Settings); it is listed here so a level sets it.
 */
const SHIELD_KEYS = ['blockTrackers', 'blockThirdPartyCookies', 'stripTracking'];
const SETTING_KEYS = ['bounceTracking', 'ampSkip', 'gpc', 'doNotTrack', 'referrerPolicy', 'webrtcPolicy', 'fingerprinting'];

const LEVELS = {
  standard: {
    id: 'standard',
    name: 'Standard',
    summary: 'Blocks trackers and tracking hops. Sites, sign-ins, calls and payments work as normal.',
    shields: { blockTrackers: true, blockThirdPartyCookies: true, stripTracking: true },
    settings: {
      bounceTracking: true, ampSkip: true, gpc: true, doNotTrack: false,
      referrerPolicy: 'standard', webrtcPolicy: 'standard', fingerprinting: 'standard',
    },
  },
  strict: {
    id: 'strict',
    name: 'Strict',
    summary: 'Also hides the page you came from, and keeps calls to your VPN or proxy. Some calls may not connect.',
    shields: { blockTrackers: true, blockThirdPartyCookies: true, stripTracking: true },
    settings: {
      bounceTracking: true, ampSkip: true, gpc: true, doNotTrack: false,
      referrerPolicy: 'strict', webrtcPolicy: 'strict', fingerprinting: 'strict',
    },
  },
};

/**
 * Which level these switches add up to: 'standard', 'strict' or 'custom'.
 * A key the settings do not carry yet (fingerprinting, before that part is
 * installed) reads as its Standard value.
 */
function levelOf(shields, settings) {
  for (const level of Object.values(LEVELS)) {
    const shieldsMatch = SHIELD_KEYS.every((key) => (shields?.[key] !== false) === level.shields[key]);
    const settingsMatch = SETTING_KEYS.every((key) => {
      const value = settings?.[key] ?? LEVELS.standard.settings[key];
      return value === level.settings[key];
    });
    if (shieldsMatch && settingsMatch) return level.id;
  }
  return 'custom';
}

module.exports = { LEVELS, SHIELD_KEYS, SETTING_KEYS, levelOf };
