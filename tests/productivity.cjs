const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, timeout = 10000) {
  const start = Date.now();
  while (!await test()) { if (Date.now() - start > timeout) throw new Error('Timed out waiting for condition'); await wait(100); }
}
async function run(browser) {
  const { app } = require('electron'), { Organizer } = require('../src/features/organizer');
  setTimeout(() => { console.error('Productivity suite exceeded 150 seconds'); app.exit(1); }, 150000).unref();
  const { ScreenTime } = require('../src/features/screen-time');
  const { organizer: org, screenTime: time } = browser.productivity;
  let fails = 0, hits = 0;
  const errors = [];
  const check = async (name, fn) => {
    try { await fn(); console.log('  ok  ' + name); }
    catch (error) { fails++; console.error('FAIL  ' + name + ': ' + error.stack); }
  };
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/never')) hits++;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>' + (req.url.includes('legal') ? 'Judgment reference' : 'Python reference') +
      '</title><h1>Static productivity fixture</h1><input id="edit" value="original"><script>window.count=0;setInterval(()=>window.count++,50)</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  browser.productivity.stop();
  time.update({ enabled: true, allowlist: [] }); time.config.rules = []; time.config.unlocks = {}; time.clearUsage();
  org.store.data.sessions = []; org.store.data.workspaces = [{ id: 'main', name: 'Main' }];
  browser.focus.finish('test'); browser.focus.update({ allowlist: [], customDomains: [], blocked: [] });
  browser.settings.update({ theme: 'dark' });
  browser.window.show(); browser.window.focus();
  await until(() => browser.tabs.active);
  const open = async (url, background = false) => {
    const id = browser.tabs.create({ url, background }), wc = browser.tabs.tabs.get(id).view.webContents;
    wc.on('console-message', event => { if (event.level === 'error' && event.message && !event.message.includes('ERR_BLOCKED_BY_CLIENT')) errors.push(event.message); });
    await until(() => !wc.isLoading() && wc.getURL());
    await wait(200); return id;
  };
  const pageId = await open('browser://organizer'), page = browser.tabs.tabs.get(pageId).view.webContents;
  const ids = [];
  for (const route of ['/code', '/code', '/code?q=other', '/legal', '/sleep', '/edited', '/pinned']) ids.push(await open(base + route, true));
  browser.tabs.tabs.get(ids[6]).pinned = true;
  browser.tabs.tabs.get(ids[4]).lastActiveAt = Date.now() - 3600000;
  await browser.tabs.tabs.get(ids[5]).view.webContents.executeJavaScript("document.getElementById('edit').value='unsaved'");
  await check('local grouping previews real open tabs and RAM metrics', async () => {
    await org.analyze(); const state = org.state();
    assert.equal(state.plan.duplicates.length, 1);
    assert.ok(state.plan.inactive.includes(ids[4]));
    assert.ok(state.tabs.some(t => t.memoryMb > 0));
    assert.ok(state.plan.groups.some(g => g.category === 'Legal'));
  });
  await check('real UI Organise Tabs and Apply groups buttons work through guarded IPC', async () => {
    await until(() => page.executeJavaScript("!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Organise Tabs')"));
    await page.executeJavaScript("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Organise Tabs').click()");
    await wait(300);
    await page.executeJavaScript("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Review and apply groups').click()");
    assert.ok(await page.executeJavaScript("!!document.querySelector('dialog[open] .p-preview-list')"));
    await page.executeJavaScript("document.querySelector('dialog form').requestSubmit()");
    await until(() => org.groups.length >= 2);
    assert.ok(await browser.chrome.webContents.executeJavaScript("document.querySelectorAll('.tab-group-chip').length>=2"));
  });
  await check('group collapse, rename, workspace move and undo preserve tab identities', async () => {
    const originalId = ids[0], group = org.groups.find(g => g.category === 'Coding');
    await org.group({ id: group.id, name: 'Python project', collapsed: true });
    assert.equal(org.groups.find(g => g.id === group.id).name, 'Python project');
    const workspace = org.workspace('Research desk');
    await org.move({ ids: [originalId], workspaceId: workspace.id });
    assert.equal(browser.tabs.tabs.get(originalId).workspaceId, workspace.id);
    await org.undo(); assert.equal(browser.tabs.tabs.get(originalId).workspaceId, 'main');
    assert.ok(browser.tabs.tabs.get(originalId).view.webContents.id);
  });
  await check('duplicate cleanup and undo reopen the saved URL', async () => {
    const before = browser.tabs.order.length;
    await org.closeDuplicates(); assert.equal(browser.tabs.order.length, before - 1);
    await org.undo(); assert.equal(browser.tabs.order.length, before);
    assert.equal(browser.tabs.list().filter(t => t.url === base + '/code').length, 2);
  });
  await check('sleep freezes timer work, protects edited/pinned tabs and wakes on select', async () => {
    const wc = browser.tabs.tabs.get(ids[4]).view.webContents;
    await org.sleep([pageId, ids[4], ids[5], ids[6]]);
    assert.ok(org.sleeping.has(ids[4]));
    assert.equal(org.sleeping.has(ids[5]), false); assert.equal(org.sleeping.has(ids[6]), false);
    // Electron executeJavaScript queues onto the frozen page; CDP can inspect
    // without resuming its task queues.
    const count = async () => (await wc.debugger.sendCommand('Runtime.evaluate', { expression: 'window.count', returnByValue: true })).result.value;
    const before = await count();
    await wait(1200);
    assert.equal(await count(), before);
    browser.tabs.select(ids[4]); await until(() => !org.sleeping.has(ids[4]));
    await until(async () => await wc.executeJavaScript('window.count') > before, 5000);
    assert.equal(wc.getURL(), base + '/sleep');
    browser.tabs.select(pageId);
  });
  await check('Gemini uses only bounded metadata and validates groups', async () => {
    const original = org.ai; let options;
    org.ai = { hasKey: () => true, generate: async input => { options = input; const tabs = JSON.parse(input.prompt);
      return { text: JSON.stringify({ groups: [{ name: 'Research bundle', category: 'Research', ids: tabs.map(t => t.id).concat('unknown') }] }) }; } };
    try {
      await org.analyze(true);
      assert.equal(options.model, 'gemini-3-flash-preview');
      assert.equal(options.prompt.includes('unsaved'), false); assert.equal(options.prompt.includes('?q='), false);
      assert.equal(org.plan.source, 'gemini'); assert.equal(org.plan.groups.flatMap(g => g.ids).includes('unknown'), false);
      org.ai.generate = async () => { throw new Error('fake service failure'); };
      await assert.rejects(() => org.analyze(true), /local suggestions/);
      assert.equal(org.plan.source, 'local');
    } finally { org.ai = original; }
  });
  await check('sessions persist groups/pins/workspaces and restore alongside current tabs', async () => {
    org.saveSession({ name: 'Integration research' });
    const restored = new Organizer(browser.dir, { getTabs: () => browser.tabs, resources: browser.resources, ai: org.ai });
    const saved = restored.store.data.sessions[0];
    assert.equal(saved.name, 'Integration research'); assert.ok(saved.tabs.some(t => t.pinned)); assert.ok(saved.groups.length);
    const before = browser.tabs.order.length;
    await org.restoreSession(saved.id); assert.equal(browser.tabs.order.length, before + saved.tabs.length);
    assert.equal(browser.tabs.activeId, pageId, 'Background session restore must not steal focus');
    const created = org.undoStack.at(-1).before.created;
    await until(() => created.every(id => !browser.tabs.tabs.get(id).state.loading)); await wait(300);
    await org.undo();
    assert.equal(browser.tabs.order.length, before, JSON.stringify(created.filter(id => browser.tabs.tabs.has(id)).map(id => ({
      id, title: browser.tabs.tabs.get(id).state.title, loading: browser.tabs.tabs.get(id).state.loading,
      active: id === browser.tabs.activeId
    }))));
  });
  await check('drag-drop board moves a tab to a different group via renderer IPC', async () => {
    await org.analyze(); await org.apply(); await wait(350);
    const result = await page.executeJavaScript("(function(){const a=document.querySelector('[data-tab-id]'), boxes=[...document.querySelectorAll('[data-group-id]')]; const b=boxes.find(x=>x.dataset.groupId && !x.contains(a));if(!a||!b)return null;const dt=new DataTransfer();a.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:dt}));b.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:dt}));a.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:dt}));return {tab:a.dataset.tabId,group:b.dataset.groupId};})()");
    assert.ok(result); await wait(250); assert.equal(browser.tabs.tabs.get(result.tab).groupId, result.group);
  });
  const timeId = await open('browser://screentime'), timePage = browser.tabs.tabs.get(timeId).view.webContents;
  await check('Screen Time form adds a scheduled rule without native dialogs', async () => {
    await until(() => timePage.executeJavaScript("!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='+ Website limit')"));
    await timePage.executeJavaScript("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='+ Website limit').click()");
    assert.ok(await timePage.executeJavaScript("!!document.querySelector('dialog[open]')"));
    await timePage.executeJavaScript("document.querySelector('dialog input[type=text]').value='news.test';document.querySelector('dialog input[type=number]').value='20';document.querySelector('dialog form').requestSubmit()");
    await until(() => time.config.rules.some(r => r.domain === 'news.test'));
    assert.equal(time.config.rules.find(r => r.domain === 'news.test').dailyMinutes, 20);
  });
  await check('foreground accounting and idle exclusion use the real active tab', async () => {
    const tab = browser.tabs.tabs.get(ids[4]); browser.tabs.select(tab.id); browser.window.focus();
    const now = Date.now(); time.last = { id: tab.id, host: '127.0.0.1', eligible: true, time: now - 1000 };
    browser.productivity.tick(); assert.ok(time.used('127.0.0.1') >= 900);
    const total = time.used('127.0.0.1'); browser.productivity.lock();
    time.last = { id: tab.id, host: '127.0.0.1', eligible: true, time: Date.now() - 1000 };
    browser.productivity.tick(); assert.equal(time.used('127.0.0.1'), total); browser.productivity.unlock();
  });
  await check('new blocked navigation never reaches server and shows a real local block screen', async () => {
    time.saveRule({ domain: '127.0.0.1', dailyMinutes: 0, schedules: [] });
    const blockedId = browser.tabs.create({ url: base + '/never' }), wc = browser.tabs.tabs.get(blockedId).view.webContents;
    await until(() => wc.getURL().includes('screentime.html') && !wc.isLoading()); await wait(300);
    assert.equal(hits, 0);
    assert.equal(new URL(wc.getURL()).searchParams.get('blocked'), base + '/never');
    assert.ok(await wc.executeJavaScript("document.body.textContent.includes('can wait.')"));
    assert.equal(await wc.executeJavaScript('typeof require'), 'undefined');
  });
  await check('existing tabs are paused as limits expire, unlock temporarily overrides Focus too', async () => {
    browser.productivity.tick(); await wait(500);
    assert.ok(browser.tabs.tabs.get(ids[4]).state.internalUrl.startsWith('browser://screentime?'));
    browser.focus.update({ customDomains: ['127.0.0.1'], blocked: [] }); browser.focus.start({ preset: 'custom', minutes: 5 });
    assert.equal(browser.productivity.policy(base).reason, 'focus');
    time.unlock(base); assert.equal(browser.productivity.policy(base), null);
    browser.tabs.navigate(browser.tabs.activeId, base + '/unlocked');
    await until(() => browser.tabs.active.view.webContents.getURL().includes('/unlocked'));
    browser.focus.finish('test'); time.config.unlocks = {}; time.config.rules = []; time.update({ allowlist: [] });
    for (const preset of ['study', 'work', 'gaming', 'legal']) {
      time.preset(preset); assert.equal(browser.productivity.policy('https://youtube.com/watch?v=lecture'), null);
    }
  });
  await check('local usage survives reloading the service', async () => {
    time.flush(); const restored = new ScreenTime(browser.dir);
    assert.ok(restored.state().todayMs > 0);
  });
  await check('both new pages render without renderer exceptions and fit the window', async () => {
    browser.window.setSize(1400, 1000); browser.window.show(); browser.window.focus(); browser.layout();
    browser.tabs.select(timeId); await wait(400);
    assert.equal(await timePage.executeJavaScript('document.documentElement.scrollWidth > innerWidth'), false);
    browser.tabs.select(pageId); page.focus(); await wait(800);
    assert.equal(await page.executeJavaScript('document.documentElement.scrollWidth > innerWidth'), false);
    assert.deepEqual(errors, []);
    const output = path.join(app.getAppPath(), '.test-output'); fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'organizer.png'), (await page.capturePage(undefined, { stayAwake: true })).toPNG());
    browser.tabs.select(timeId); timePage.focus(); await wait(800);
    fs.writeFileSync(path.join(output, 'screentime.png'), (await timePage.capturePage(undefined, { stayAwake: true })).toPNG());
  });
  server.close(); browser.productivity.stop(); browser.flush();
  console.log(fails ? fails + ' productivity checks failed.' : 'All productivity integration checks passed.');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
