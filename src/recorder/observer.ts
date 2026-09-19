/**
 * Runs inside the page. Reports clicks, inputs, selects, Enter presses and
 * submits to Node through `window.__autobrowse(action)`, each with locator
 * hints computed from the DOM at that moment. Plain JS in a string: it is
 * injected with `addInitScript` and must not depend on this bundle.
 */
export const BINDING = "__autobrowse";

export const OBSERVER_SCRIPT = `
(() => {
  if (window.__autobrowseObserving) return;
  window.__autobrowseObserving = true;
  const IMPLICIT = { a: 'link', button: 'button', select: 'combobox', textarea: 'textbox', option: 'option', img: 'img', h1: 'heading', h2: 'heading', h3: 'heading', nav: 'navigation', form: 'form' };
  const INPUT_ROLES = { checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button', reset: 'button', range: 'slider', number: 'spinbutton', search: 'searchbox' };
  const trim = (s) => (s ? s.replace(/\\s+/g, ' ').trim().slice(0, 80) : null) || null;
  const labelFor = (el) => {
    if (el.labels && el.labels.length) return trim(el.labels[0].textContent);
    const wrap = el.closest('label');
    return wrap ? trim(wrap.textContent) : null;
  };
  const hints = (el) => {
    const tag = el.tagName.toLowerCase();
    const inputType = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : null;
    const role = el.getAttribute('role') || (inputType ? (INPUT_ROLES[inputType] || 'textbox') : IMPLICIT[tag]) || null;
    const name = trim(el.getAttribute('aria-label')) || labelFor(el) || (tag === 'button' || role === 'button' || tag === 'a' ? trim(el.textContent) : null) || trim(el.getAttribute('alt')) || trim(el.getAttribute('title')) || trim(el.getAttribute('placeholder')) || (inputType === 'submit' ? trim(el.value) : null);
    return {
      tag, role, name,
      text: trim(el.textContent),
      placeholder: trim(el.getAttribute('placeholder')),
      id: el.id || null,
      testId: el.getAttribute('data-testid') || el.getAttribute('data-test') || null,
      href: tag === 'a' ? el.getAttribute('href') : null,
      inputType,
    };
  };
  const interactive = (el) => el.closest('button, a, input, select, textarea, [role], [onclick], label, summary') || el;
  const send = (a) => { try { window.${BINDING}(a); } catch (e) {} };
  document.addEventListener('click', (e) => {
    const el = interactive(e.target);
    if (!(el instanceof Element)) return;
    send({ kind: 'click', target: hints(el) });
  }, true);
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (!(el instanceof Element)) return;
    const tag = el.tagName.toLowerCase();
    if (tag === 'select') send({ kind: 'select', target: hints(el), value: el.value });
    else if (tag === 'input' || tag === 'textarea') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox' || t === 'radio') return;
      send({ kind: 'input', target: hints(el), value: el.value });
    }
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== 'Escape' && e.key !== 'Tab') return;
    const el = e.target;
    if (!(el instanceof Element)) return;
    send({ kind: 'press', target: hints(el), key: e.key });
  }, true);
  document.addEventListener('submit', (e) => {
    const el = e.target;
    if (!(el instanceof Element)) return;
    send({ kind: 'submit', target: hints(el) });
  }, true);
})();
`;
