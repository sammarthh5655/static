const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Shields checks. Run with `npm run test:shields`.
 *
 * The assertions split in two, and both matter:
 *   - it BLOCKS ad and tracker networks
 *   - it does NOT block ordinary CDNs, first-party requests, or localhost
 *
 * Over-blocking is the failure mode that makes people turn a blocker off, so
 * the negative assertions are as important as the positive ones.
 */
async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (name, ok, detail) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + name + (detail ? ' :: ' + String(detail).slice(0, 130) : ''));
    if (!ok) fails++;
  };

  try {
    browser.window.show();
    await wait(1000);

    const inspect = (url, docHost, type = 'script') =>
      browser.shields.inspect({ url, docHost, resourceType: type, tabId: null });

    check('shields present', !!browser.shields && typeof browser.shields.inspect === 'function');
    check('rules loaded', browser.shields.engine.count > 30, browser.shields.engine.count + ' rules');

    // Blocks.
    check('blocks doubleclick', inspect('https://ad.doubleclick.net/x.js', 'news.com')?.block === true);
    check('blocks google-analytics', inspect('https://www.google-analytics.com/analytics.js', 'news.com')?.block === true);
    check('blocks facebook pixel cross-site', inspect('https://www.facebook.com/tr?id=1', 'news.com')?.block === true);

    // Does not over-block.
    // NOT the Facebook pixel: EasyPrivacy blocks ||facebook.com/tr? with no
    // $third-party option, so it is blocked on facebook.com too - that is the
    // list's deliberate intent, not over-blocking. Test a real first-party
    // asset instead.
    check('allows first-party assets', !inspect('https://www.facebook.com/images/logo.png', 'facebook.com', 'image')?.block);
    check('allows a normal CDN', !inspect('https://cdn.jsdelivr.net/npm/x.js', 'news.com')?.block);
    check('allows first-party scripts', !inspect('https://news.com/app.js', 'news.com')?.block);

    // Rewriting.
    const rewritten = browser.shields.rewrite('http://example.com/page?utm_source=x&id=7&fbclid=abc');
    check('upgrades http to https', rewritten.startsWith('https://'), rewritten);
    check('strips tracking parameters', !/utm_source|fbclid/.test(rewritten), rewritten);
    check('keeps real parameters', rewritten.includes('id=7'), rewritten);
    check('leaves localhost on http',
      browser.shields.rewrite('http://localhost:3000/app').startsWith('http://localhost'));

    // Per-site control.
    browser.shields.setSiteEnabled('news.com', false);
    check('per-site off stops blocking', !inspect('https://ad.doubleclick.net/x.js', 'news.com')?.block);
    check('other sites stay protected', inspect('https://ad.doubleclick.net/x.js', 'other.com')?.block === true);
    browser.shields.setSiteEnabled('news.com', true);
    check('re-enabling restores blocking', inspect('https://ad.doubleclick.net/x.js', 'news.com')?.block === true);

    // Matching must stay fast: this runs on every request a page makes.
    const urls = ['https://ad.doubleclick.net/x.js', 'https://cdn.jsdelivr.net/a.js',
      'https://news.com/app.js', 'https://analytics.example.com/t.gif'];
    const started = Date.now();
    for (let i = 0; i < 20000; i++) {
      browser.shields.engine.match({ url: urls[i % 4], docHost: 'news.com', resourceType: 'script' });
    }
    const perRequest = (Date.now() - started) * 1000 / 20000;
    check('matching is fast enough', perRequest < 200, perRequest.toFixed(1) + 'us per request');

    // A real page: blocks something, and still loads.
    const id = browser.tabs.create({ url: 'https://edition.cnn.com/' });
    const tab = browser.tabs.tabs.get(id);
    for (let i = 0; i < 80 && tab.view.webContents.isLoading(); i++) await wait(300);
    await wait(3000);
    const report = browser.shields.tabReport(id);
    check('blocks on a real site', report.count > 0,
      report.count + ' from ' + report.sources.length + ' hosts');
    check('real site still loads', (tab.state.title || '').length > 0, tab.state.title);
    browser.tabs.close(id);

    // ---- scriptlets: video ads --------------------------------------------
    // Network rules CANNOT block YouTube video ads: they come from the same
    // googlevideo.com endpoint as the video itself, so blocking them blocks
    // the content. These assertions cover the part only scriptlet injection
    // into the page's main world can do.
    const ytTab = browser.tabs.create({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
    const yt = browser.tabs.tabs.get(ytTab);
    for (let i = 0; i < 90 && yt.view.webContents.isLoading(); i++) await wait(300);
    await wait(7000);

    const player = await yt.view.webContents.executeJavaScript(`({
      ran: !!window.__staticScriptletsRan,
      adPlacements: (window.ytInitialPlayerResponse && window.ytInitialPlayerResponse.adPlacements)
        ? window.ytInitialPlayerResponse.adPlacements.length : 0,
      playerAds: (window.ytInitialPlayerResponse && window.ytInitialPlayerResponse.playerAds)
        ? window.ytInitialPlayerResponse.playerAds.length : 0,
      // Whether an AD is actually playing, not whether a transient CSS class
      // appeared. The player briefly sets .ad-showing while it works out it
      // has no ads, which is not a user-visible ad.
      playingAd: (() => {
        const player = document.getElementById('movie_player');
        try { return !!(player && player.getVideoData && player.getVideoData().isAd); }
        catch (e) { return false; }
      })(),
      playingVideoId: (() => {
        const player = document.getElementById('movie_player');
        try { return player && player.getVideoData ? player.getVideoData().video_id : null; }
        catch (e) { return null; }
      })(),
      hasVideo: !!document.querySelector('video'),
      title: document.title,
    })`).catch((error) => ({ error: error.message }));

    check('scriptlets run on YouTube', player.ran === true, player.error || '');
    // The injection must reach the PAGE's own world at document-start. It is
    // what installs the accessor ahead of `var ytInitialPlayerResponse = ...`,
    // and `removed` counts the ad payloads it actually stripped. A zero here
    // means it ran too late to matter, which is how earlier versions failed
    // while still reporting that they had run.
    const guard = await yt.view.webContents.executeJavaScript(`({
      injected: !!window.__staticYt,
      removed: typeof window.__staticAdsRemoved === 'function' ? window.__staticAdsRemoved() : -1,
      adKeysGone: window.ytInitialPlayerResponse
        ? !('adPlacements' in window.ytInitialPlayerResponse) : 'no-obj',
    })`).catch((error) => ({ error: error.message }));
    check('ad stripper injected at document-start', guard.injected === true, guard.error || '');
    // The fetch wrapper must still be OURS. Two separate injections used to
    // patch window.fetch on YouTube - the preload's (document-start) and a
    // scriptlet injected later from main - and the later one silently replaced
    // the earlier. The surviving wrapper was the older implementation, which
    // reassigns `data.adPlacements = []` instead of emptying the array in
    // place, so a player already holding a reference to that array kept its
    // ads. Every existing assertion still passed, because the document-start
    // var-trap keeps the FIRST load clean on its own; the damage was to every
    // video after it. This asserts the ownership that guarantees the rest.
    const owner = await yt.view.webContents.executeJavaScript(
      '({ ours: !!(window.fetch && window.fetch.__static) })'
    ).catch((error) => ({ error: error.message }));
    check('our fetch wrapper is the one installed', owner.ours === true,
      owner.error || 'window.fetch is not ours: ours=' + owner.ours);

    check('ad payloads actually stripped', guard.removed > 0, 'removed=' + guard.removed);
    check('ad keys gone from the object the player reads',
      guard.adKeysGone === true, String(guard.adKeysGone));

    // Navigating to a second video WITHIN the session fetches a fresh player
    // response over fetch(), not from the HTML. Hooking only XMLHttpRequest
    // left this path untouched, which is why ads kept appearing after the
    // first video. This is the regression guard for that.
    await yt.view.webContents.executeJavaScript(`(function(){
      var a = document.createElement('a');
      a.href = '/watch?v=jNQXAC9IVRw';
      document.body.appendChild(a);
      a.click();
    })()`).catch(() => {});
    await wait(9000);
    const second = await yt.view.webContents.executeJavaScript(`({
      stats: window.__staticAdStats(),
      removed: window.__staticAdsRemoved(),
      adKeysGone: window.ytInitialPlayerResponse
        ? !('adPlacements' in window.ytInitialPlayerResponse) : 'no-obj',
      playingAd: (function(){ try { var p = document.getElementById('movie_player');
        return !!(p && p.getVideoData && p.getVideoData().isAd); } catch (e) { return 'err'; } })(),
      videoTime: (function(){ var v = document.querySelector('video');
        return v ? Math.round(v.currentTime) : -1; })(),
      onSecondVideo: location.href.indexOf('jNQXAC9IVRw') !== -1,
    })`).catch((error) => ({ error: error.message }));
    check('in-session navigation reaches the second video',
      second.onSecondVideo === true, second.error || '');
    // Counters are per-video and split by source. A single cumulative total
    // was worse than no assertion at all: it was already non-zero from the
    // first video's var trap, so "the fetch hook stripped something" was true
    // even with the fetch hook entirely absent.
    check('fetch() player response is stripped too',
      second.stats && second.stats.fetch > 0,
      'stats=' + JSON.stringify(second.stats));
    check('no ad plays on the second video', second.playingAd === false);
    check('second video actually plays', second.videoTime > 0, 'currentTime=' + second.videoTime);

    // Self-healing. The preload runs ONCE PER DOCUMENT, and YouTube never
    // loads a new document when you click between videos - so an hour of
    // watching is one document, and everything rests on the fetch hook
    // surviving untouched. It does not have to: the page's own code, or an
    // extension's content script, can reassign window.fetch at any point and
    // silently unhook ad blocking for the rest of the session. This is the
    // difference between passing tests and the user still seeing ads.
    const stomped = await yt.view.webContents.executeJavaScript(`(function(){
      var native = window.fetch;
      window.fetch = function(){ return native.apply(this, arguments); };
      return !!(window.fetch && window.fetch.__static);
    })()`).catch(() => null);
    check('a third party can displace our fetch hook', stomped === false,
      'expected the stomp to take effect');

    await yt.view.webContents.executeJavaScript(`(function(){
      var a = document.createElement('a');
      a.href = '/watch?v=kffacxfA7G4';
      document.body.appendChild(a);
      a.click();
    })()`).catch(() => {});
    await wait(9000);
    // Wait for the video to actually start rather than sampling at a fixed
    // instant. Re-navigating to an earlier video re-buffers from scratch, so
    // a single sample at 9s catches it at readyState 0 - still loading, not
    // broken. Poll up to 20s more.
    for (let i = 0; i < 40; i++) {
      const t = await yt.view.webContents.executeJavaScript(
        '(function(){ var v = document.querySelector("video"); return v ? v.currentTime : 0; })()'
      ).catch(() => 0);
      if (t > 0) break;
      await wait(500);
    }
    const healed = await yt.view.webContents.executeJavaScript(`({
      ours: !!(window.fetch && window.fetch.__static),
      stats: window.__staticAdStats(),
      playingAd: (function(){ try { var p = document.getElementById('movie_player');
        return !!(p && p.getVideoData && p.getVideoData().isAd); } catch (e) { return 'err'; } })(),
      videoTime: (function(){ var v = document.querySelector('video');
        return v ? Math.round(v.currentTime) : -1; })(),
      paused: (function(){ var v = document.querySelector('video');
        return v ? v.paused : 'no-video'; })(),
      readyState: (function(){ var v = document.querySelector('video');
        return v ? v.readyState : -1; })(),
      url: location.href.slice(-11),
    })`).catch((error) => ({ error: error.message }));
    console.log('    [diag] healed=' + JSON.stringify(healed));
    check('the hook is reinstalled on the next navigation', healed.ours === true,
      healed.error || 'window.fetch stayed displaced for the rest of the session');
    check('ads still stripped after being unhooked', healed.stats && healed.stats.total > 0,
      'stats=' + JSON.stringify(healed.stats));
    check('no ad plays after re-healing', healed.playingAd === false);
    check('video still plays after re-healing', healed.videoTime > 0,
      'currentTime=' + healed.videoTime);


    check('ad placements stripped', player.adPlacements === 0, 'adPlacements=' + player.adPlacements);
    check('player ads stripped', player.playerAds === 0, 'playerAds=' + player.playerAds);
    check('no ad is playing', player.playingAd === false,
      'video_id=' + player.playingVideoId);
    check('the real video still loads', player.hasVideo === true, player.title);
    browser.tabs.close(ytTab);

    // Cosmetic hiding: the containers YouTube renders ads into must not be
    // visible. Checked on a live page because the selector list was wrong
    // until it was verified against one.
    const ytHome = browser.tabs.create({ url: 'https://www.youtube.com' });
    const home = browser.tabs.tabs.get(ytHome);
    for (let i = 0; i < 90 && home.view.webContents.isLoading(); i++) await wait(300);
    await wait(4500);
    const cosmetic = await home.view.webContents.executeJavaScript(`(function(){
      var sel = ['ytd-ad-slot-renderer','ytd-in-feed-ad-layout-renderer','#player-ads',
                 '#masthead-ad','ytd-promoted-video-renderer','ytd-display-ad-renderer'];
      var visible = 0;
      sel.forEach(function(s){
        document.querySelectorAll(s).forEach(function(el){
          if (getComputedStyle(el).display !== 'none' && el.offsetHeight > 0) visible++;
        });
      });
      var sponsored = [].slice.call(document.querySelectorAll('*')).filter(function(e){
        return e.children.length === 0 &&
               /^sponsored$/i.test((e.textContent||'').trim()) && e.offsetHeight > 0;
      }).length;
      return { visible: visible, sponsored: sponsored };
    })()`).catch((error) => ({ error: error.message }));
    check('no visible ad containers on YouTube', cosmetic.visible === 0,
      cosmetic.visible + ' visible');
    check('no visible Sponsored labels', cosmetic.sponsored === 0,
      cosmetic.sponsored + ' labels');

    // Cosmetic rules from the downloaded lists must actually be parsed and
    // used. They were previously matched and thrown away, so the ad REQUEST
    // was blocked everywhere but the container was only hidden on the handful
    // of sites covered by the hand-written stylesheet - leaving an empty
    // reserved box, often still labelled "Advertisement", on the rest of the
    // web.
    check('cosmetic rules are loaded from the lists',
      browser.shields.engine.cosmeticCount > 1000,
      browser.shields.engine.cosmeticCount + ' cosmetic rules');
    const ytCss = browser.shields.engine.cosmeticFor('youtube.com');
    const cnnCss = browser.shields.engine.cosmeticFor('cnn.com');
    check('cosmetic CSS is produced for a real site', cnnCss.length > 1000,
      cnnCss.length + ' chars');
    check('cosmetic CSS is site-specific', ytCss !== cnnCss);
    // Domain scoping must walk up to the parent domain, or a rule written for
    // example.com would never apply on news.example.com.
    const engine = new (require('../src/features/shields/filters').FilterEngine)();
    engine.addList(['##.everywhere', 'example.com##.scoped'].join('\n'));
    check('generic cosmetic rules apply to any host',
      engine.cosmeticFor('anything.test').includes('.everywhere'));
    check('scoped cosmetic rules reach subdomains',
      engine.cosmeticFor('news.example.com').includes('.scoped'));
    check('scoped cosmetic rules do not leak to other sites',
      !engine.cosmeticFor('other.test').includes('.scoped'));

    // The menu overlay must sit ABOVE the page. It previously rendered behind
    // a real site, because resizing the overlay did not reorder it and any
    // tab added afterwards sat on top.
    await browser.chrome.webContents.executeJavaScript(
      "document.getElementById('app-menu').click()");
    await wait(900);
    const children = browser.window.contentView.children;
    const overlayIndex = children.indexOf(browser.overlay);
    check('menu overlay is the topmost view', overlayIndex === children.length - 1,
      'index ' + overlayIndex + ' of ' + children.length);
    await browser.overlay.webContents.executeJavaScript('window.ui.closeMenu()').catch(() => {});
    browser.tabs.close(ytHome);

    // Scriptlets must not break ordinary sites. This is the failure that
    // matters most here: a broken page is worse than an unblocked ad.
    for (const [label, url] of [
      ['wikipedia', 'https://en.wikipedia.org/wiki/Advertising'],
      ['github', 'https://github.com/electron/electron'],
    ]) {
      const siteTab = browser.tabs.create({ url });
      const site = browser.tabs.tabs.get(siteTab);
      for (let i = 0; i < 80 && site.view.webContents.isLoading(); i++) await wait(300);
      await wait(2500);
      const page = await site.view.webContents.executeJavaScript(`({
        ran: !!window.__staticScriptletsRan,
        text: document.body ? document.body.innerText.trim().length : 0,
        title: document.title,
      })`).catch((error) => ({ error: error.message }));
      check(label + ' still renders with scriptlets active',
        page.ran === true && page.text > 2000, page.title || page.error);
      browser.tabs.close(siteTab);
    }

    console.log(fails ? '\n' + fails + ' check(s) failed.\n' : '\nAll shields checks passed.\n');
    app.exit(fails ? 1 : 0);
  } catch (error) {
    console.error('Shields test failed:', error);
    app.exit(1);
  }
}

module.exports = { run };
