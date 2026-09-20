(function () {
  const { element: e, icon } = window.page;
  const button = (text, run, primary = false, disabled = false) => e('button', { class: 'p-button' + (primary ? ' primary' : ''), text,
    disabled: disabled ? '' : null, onclick: run });
  const row = children => e('div', { class: 'p-row' }, children);
  const muted = text => e('p', { class: 'p-muted', text });
  const card = (title, children, glyph = 'grid') => e('section', { class: 'p-card' }, [
    e('h2', {}, [icon(glyph), title]), ...children,
  ]);
  const duration = ms => ms < 60000 ? Math.floor(ms / 1000) + 's' : ms < 3600000 ? Math.floor(ms / 60000) + 'm' :
    Math.floor(ms / 3600000) + 'h ' + Math.floor(ms % 3600000 / 60000) + 'm';
  function modal(title, build, submitText = 'Save') {
    const dialog = e('dialog', { class: 'p-dialog' });
    const form = e('form', { method: 'dialog' }), message = e('p', { class: 'p-error', role: 'alert' });
    const body = e('div'), submit = e('button', { type: 'submit', class: 'p-button primary', text: submitText });
    const close = () => { dialog.close(); dialog.remove(); };
    const handler = build(body, close);
    form.append(e('h2', { text: title }), body, message, row([
      e('button', { type: 'button', class: 'p-button', text: 'Cancel', onclick: close }), submit,
    ]));
    form.addEventListener('submit', async event => {
      event.preventDefault(); submit.disabled = true;
      try { await handler(); close(); } catch (error) { message.textContent = error.message; submit.disabled = false; }
    });
    dialog.append(form); dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog); dialog.showModal();
    return dialog;
  }
  function field(label, control) { return e('label', { class: 'p-field' }, [e('span', { text: label }), control]); }
  function nameDialog(title, value, run) {
    return modal(title, body => {
      const input = e('input', { type: 'text', value, required: '', maxlength: 80, autofocus: '' });
      body.append(field('Name', input)); return () => run(input.value);
    });
  }
  function confirm(title, message, run, label = 'Continue') {
    return modal(title, body => { body.append(muted(message)); return run; }, label);
  }
  window.productivityUI = { e, button, row, muted, card, duration, modal, field, nameDialog, confirm };
})();
