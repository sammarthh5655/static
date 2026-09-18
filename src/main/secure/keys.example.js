// Template for src/main/secure/keys.js, which is gitignored.
//
// Copy this file to keys.js and fill in the key. keys.js is bundled into the
// app at build time and is never exposed to any renderer or web page: all
// Gemini calls are made from the main process (see features/ai/gemini.js), and
// the key never crosses an IPC boundary.
//
// SECURITY NOTE - read before shipping:
// A key embedded in a desktop app is not secret. The app ships to the user's
// disk, so anyone can extract it from the bundle or observe the network call.
// Obfuscation only raises the effort. The protection that actually works is on
// the Google side: restrict the key and cap its quota in Google AI Studio so a
// leak is bounded rather than open-ended.
module.exports = {
  gemini: '',
};
