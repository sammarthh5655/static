const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (n, ok, d) => {
    console.log((ok?'  ok  ':'FAIL  ')+n+(d?' :: '+String(d).slice(0,140):''));
    if(!ok) fails++;
  };
  try {
    browser.window.show(); await wait(1200);
    browser.tabs.navigate(browser.tabs.activeId, 'browser://licences');
    const wc = browser.tabs.active.view.webContents;
    for (let i=0;i<50&&wc.isLoading();i++) await wait(200);
    await wait(900);
    const errors = [];
    wc.on('console-message', (e) => {
      if (e?.level==='error'||e?.level===3) errors.push(String(e.message).slice(0,140));
    });
    const view = await wc.executeJavaScript(`({
      credits: document.querySelectorAll('.credit').length,
      licences: [...document.querySelectorAll('.credit-licence')].map(n=>n.textContent),
      obligations: document.querySelectorAll('.credit-obligation').length,
      privacy: document.querySelectorAll('#privacy .field').length,
    })`);
    check('every dependency is credited', view.credits >= 7, view.credits + ' credits');
    check('each one states its licence', view.licences.length === view.credits,
      view.licences.join(', '));
    check('the copyleft ones are named',
      view.licences.some(l=>/GPL-3/.test(l)) && view.licences.some(l=>/MPL-2/.test(l)),
      view.licences.join(', '));
    check('each says what it obliges US to do', view.obligations === view.credits);
    check('and what happens to the user data', view.privacy >= 4, view.privacy + ' rows');
    check('no page errors', errors.length === 0, errors.join(' | '));
  } catch (e) { check('probe completed', false, e.message); }
  console.log(fails?'\nFAILURES: '+fails:'\nall licence checks passed');
  app.exit(fails?1:0);
}
module.exports={run};
