// Integration smoke test for the new interaction capabilities.
// Starts a headless Chrome, applies emulateVisible, and exercises cdp_send,
// mouse click, key down/up, text input and waitFor against a local test page.
import { BrowserHub } from '../dist/hub.js';

const hub = new BrowserHub({ captureRoot: '/tmp/cap-interaction-test' });
const results = [];
const ok = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

try {
  const launched = await hub.launch({
    kind: 'chrome',
    headless: true,
    emulateVisible: true,
    url: 'about:blank',
  });
  console.log(`launched ${launched.display} on port ${launched.port}`);
  const session = hub.activeSession;

  // Build an in-page harness that records real input events. We use the DOM API
  // (not document.write) because an inline <script> written via document.write() on
  // an already-loaded about:blank document does NOT execute, so listeners never
  // attach. Here the listeners are attached synchronously by evaluate().
  await session.evaluate(`(function(){
    window.__events = [];
    var body = document.body || document.documentElement;
    body.innerHTML = '<div id="box" style="position:absolute;left:0;top:0;width:60px;height:60px;background:#0a0"></div><input id="f" />';
    var push = function(e){ window.__events.push(e.type + ':' + (e.key || '') + '/' + (e.code || '')); };
    document.addEventListener('click', function(e){ window.__events.push('click@' + e.clientX + ',' + e.clientY); });
    document.addEventListener('mousedown', function(e){ window.__events.push('mousedown@' + e.clientX + ',' + e.clientY); });
    window.addEventListener('keydown', push);
    window.addEventListener('keyup', push);
    var f = document.getElementById('f');
    f.addEventListener('input', function(e){ window.__events.push('input:' + e.target.value); });
    f.focus();
  })()`);

  // 1) emulateVisible => document.visibilityState must be 'visible' (headless default is 'hidden')
  const vis = await session.evaluate('document.visibilityState');
  ok('emulateVisible overrides visibilityState', vis.value === 'visible', `visibilityState=${vis.value}`);

  // 2) cdp_send raw passthrough (Emulation.setPageVisibilityOverride was removed in
  //    recent Chrome; Page.setWebLifecycleState is the supported visibility-equivalent)
  const cdp = await session.cdpSend('Page.setWebLifecycleState', { state: 'active' });
  ok('cdp_send returns a result object', cdp !== undefined && typeof cdp === 'object', JSON.stringify(cdp));

  // 3) real mouse click on #box (center 30,30)
  await session.mouseClick({ x: 30, y: 30 });
  const ev1 = await session.evaluate('window.__events');
  const clickedInside = (ev1.value || []).some((e) => /^mousedown@30,30$/.test(e) || /^click@30,30$/.test(e));
  ok('page_click dispatches real mouse at (30,30)', clickedInside, (ev1.value || []).join(' | '));

  // 4) key down / up (hold then release)
  await session.keyDispatch({ key: 'd', action: 'down' });
  await session.keyDispatch({ key: 'd', action: 'up' });
  const ev2 = await session.evaluate('window.__events');
  const keyOk = (ev2.value || []).some((e) => e === 'keydown:d/KeyD') && (ev2.value || []).some((e) => e === 'keyup:d/KeyD');
  ok('page_key sends real keydown/keyup with code KeyD', keyOk, (ev2.value || []).join(' | '));

  // 5) text input via Input.insertText
  await session.evaluate('document.getElementById("f").focus()');
  await session.typeText('hello');
  const ev3 = await session.evaluate('window.__events');
  const typed = (ev3.value || []).some((e) => e === 'input:hello');
  ok('page_type inserts text "hello"', typed, (ev3.value || []).join(' | '));

  // 6) waitFor predicate
  await session.evaluate('window.__ready = true');
  const waited = await session.waitFor({ predicate: 'window.__ready === true', timeoutMs: 3000 });
  ok('page_wait_for resolves on predicate', waited.matched === true, JSON.stringify(waited));

  await hub.closeSession({ killBrowser: true });
} catch (err) {
  ok('fatal', false, err && err.message);
} finally {
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
