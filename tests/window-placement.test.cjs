const test = require('node:test');
const assert = require('node:assert/strict');
const { overlapsEnough } = require('../src/main/window');

// A window reopened where no screen is any more starts, but nobody can see
// it: the app looks like it did not launch at all. These are the real
// numbers from that happening - a window saved at x=1922 on a second monitor,
// reopened on a machine with only a 1920-wide screen.
const SCREEN = { x: 0, y: 0, width: 1920, height: 1080 };

test('a window saved on a monitor that is gone is not on screen', () => {
  assert.equal(overlapsEnough({ x: 1922, y: 0, width: 957, height: 1079 }, SCREEN), false);
  // Off the other edges too.
  assert.equal(overlapsEnough({ x: -1000, y: 0, width: 900, height: 700 }, SCREEN), false);
  assert.equal(overlapsEnough({ x: 400, y: 1200, width: 900, height: 700 }, SCREEN), false);
  assert.equal(overlapsEnough({ x: 400, y: -800, width: 900, height: 700 }, SCREEN), false);
});

test('a window on the screen, or mostly on it, is kept where it was', () => {
  assert.equal(overlapsEnough({ x: 0, y: 0, width: 1920, height: 1080 }, SCREEN), true);
  assert.equal(overlapsEnough({ x: 300, y: 100, width: 900, height: 700 }, SCREEN), true);
  // Hanging off the right edge, but with plenty still showing to grab.
  assert.equal(overlapsEnough({ x: 1500, y: 100, width: 900, height: 700 }, SCREEN), true);
});

test('a sliver of a window showing does not count as on screen', () => {
  // 50px visible: too little to find or drag back.
  assert.equal(overlapsEnough({ x: 1870, y: 100, width: 900, height: 700 }, SCREEN), false);
  // Only a thin band vertically.
  assert.equal(overlapsEnough({ x: 300, y: 1040, width: 900, height: 700 }, SCREEN), false);
});

test('a second screen to the right is a real place for a window', () => {
  const second = { x: 1920, y: 0, width: 1920, height: 1080 };
  assert.equal(overlapsEnough({ x: 1922, y: 0, width: 957, height: 1079 }, second), true);
});

test('nonsense bounds are refused rather than trusted', () => {
  assert.equal(overlapsEnough(null, SCREEN), false);
  assert.equal(overlapsEnough({ x: 0, y: 0, width: 900, height: 700 }, null), false);
});
