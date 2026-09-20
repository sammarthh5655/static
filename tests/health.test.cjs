const test = require('node:test');
const assert = require('node:assert/strict');
const { Health } = require('../src/features/health');

/**
 * The health report's whole value is that its status can be traced to a stated
 * finding. These tests hold it to never reporting good news it did not measure.
 */

test('an absent shields module reports unknown, not "on"', () => {
  const report = new Health({ dir: '/nonexistent-health-path' }).report();
  assert.equal(report.sections.privacy.enabled, null, 'not reported as enabled');
  assert.equal(report.sections.privacy.ruleCount, null, 'no invented rule count');
  assert.ok(report.findings.some((finding) => finding.id === 'shields-unavailable'),
    'and it says why');
});

test('an absent password vault is not reported as checked', () => {
  const report = new Health({ dir: '/nonexistent-health-path' }).report();
  assert.equal(report.sections.security.vault.checked, false);
  assert.ok(report.findings.some((finding) => finding.id === 'vault-unavailable'));
});

test('a browser with nothing measurable is never "excellent"', () => {
  const report = new Health({ dir: '/nonexistent-health-path' }).report();
  assert.notEqual(report.status, 'excellent',
    'an unmeasurable browser must not report a clean bill of health');
});

test('every finding that sets the status is returned alongside it', () => {
  const report = new Health({
    dir: '/nonexistent-health-path',
    shields: { config: { enabled: false }, engine: { count: 0, cosmeticCount: 0 } },
    passwords: { state: () => ({ available: true }), list: () => [] },
  }).report();

  assert.equal(report.status, 'critical');
  const critical = report.findings.filter((finding) => finding.level === 'critical');
  assert.ok(critical.length, 'the critical status is traceable to a finding');
  assert.equal(critical[0].id, 'shields-off');
});

test('shields switched on with everything enabled reports enabled', () => {
  const report = new Health({
    dir: '/nonexistent-health-path',
    shields: {
      config: {
        enabled: true, blockTrackers: true, upgradeHttps: true, stripTracking: true,
        blockThirdPartyCookies: true, blockVideoAds: true,
      },
      engine: { count: 1000, cosmeticCount: 50 },
    },
  }).report();

  assert.equal(report.sections.privacy.enabled, true);
  assert.equal(report.sections.privacy.ruleCount, 1000);
  assert.ok(!report.findings.some((finding) => finding.id === 'shields-unavailable'));
});

test('individually disabled protections are named, not hidden by the master switch', () => {
  const report = new Health({
    dir: '/nonexistent-health-path',
    shields: {
      config: { enabled: true, blockTrackers: true, upgradeHttps: false, blockVideoAds: false },
      engine: { count: 1, cosmeticCount: 0 },
    },
  }).report();

  const finding = report.findings.find((item) => item.id === 'protections-off');
  assert.ok(finding, 'the disabled protections are reported');
  assert.match(finding.detail, /HTTPS/);
  assert.match(finding.detail, /Video ad/);
});
