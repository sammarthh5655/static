'use strict';

/**
 * Shared implementation for browser://student and browser://legal.
 *
 * Both are the same shape - pick a task, give it source text, read the result
 * beside the source - so they share one script and differ only in which task
 * catalogue they load. `window.WORKSPACE_MODE` is set by the page before this
 * script runs.
 */
(function () {

const { invoke, onState, element, icon } = window.page;
const narrator = window.narrator;

const mode = window.WORKSPACE_MODE || 'student';
const isLegal = mode === 'legal';

let tasks = [];
let disclaimer = '';
let activeTask = null;
let sourceText = '';
let sourceLabel = '';
let output = '';
let outputModel = '';
let outputError = false;
let busy = false;
let shellApi = null;

const content = element('div');

/**
 * Legal leads with "Read this page" (readpage.js): the web page the person was
 * just on, read in one go. Its page text can then become the source below, so
 * a case brief or timeline of the same page is one more click.
 */
const readPage = isLegal
  ? window.readPage.create({
      mode,
      disclaimer: () => disclaimer,
      onUseAsSource: (text, source) => {
        sourceText = text;
        sourceArea.value = text;
        sourceLabel = source.title || source.host || '';
        updateMeta();
        sourceArea.scrollIntoView({ block: 'center', behavior: 'smooth' });
      },
    })
  : null;

/* ---- source --------------------------------------------------------------- */

const sourceArea = element('textarea', {
  class: 'workspace-source',
  placeholder: isLegal
    ? 'Paste a judgment, notice, petition or set of facts…'
    : 'Paste an article, chapter or your own notes…',
  spellcheck: 'false',
});
sourceArea.addEventListener('input', () => { sourceText = sourceArea.value; updateMeta(); });

const sourceMeta = element('div', { class: 'workspace-meta' });

function updateMeta() {
  const words = sourceText.trim() ? sourceText.trim().split(/\s+/).length : 0;
  sourceMeta.textContent = words
    ? `${words.toLocaleString()} words${sourceLabel ? ' · ' + sourceLabel : ''}`
    : 'No source yet';
}

async function useCurrentPage() {
  const result = await invoke('workspace:page-text');
  if (!result?.ok) {
    setOutput(result?.error || 'Could not read the page.', true);
    return;
  }
  sourceText = result.text;
  sourceArea.value = result.text;
  sourceLabel = result.title || result.url;
  updateMeta();
}

/* ---- running a task ------------------------------------------------------- */

const outputArea = element('div', { class: 'workspace-output-text' });
const outputHead = element('div', { class: 'workspace-output-head' });

function setOutput(text, isError = false) {
  output = text;
  outputError = isError;
  outputArea.textContent = text;
  outputArea.classList.toggle('error', isError);
  renderOutputHead();
}

function renderOutputHead() {
  const listening = narrator?.state().key === 'output' && (narrator.state().playing || narrator.state().paused);
  outputHead.replaceChildren(...[
    element('span', {
      class: 'workspace-output-title',
      text: activeTask ? (tasks.find((t) => t.id === activeTask)?.name || 'Result') : 'Result',
    }),
    outputModel ? element('span', { class: 'muted', text: outputModel }) : null,
    // An error message is not worth listening to.
    output && !busy && !outputError && narrator?.available()
      ? element('button', {
          class: 'turn-tool' + (listening ? ' active' : ''),
          text: listening ? (narrator.state().paused ? 'Carry on' : 'Pause') : 'Listen',
          onclick: () => {
            if (listening) { narrator.toggle(); return; }
            narrator.play({
              title: (tasks.find((t) => t.id === activeTask)?.name || 'Result')
                + (sourceLabel ? ' · ' + sourceLabel : ''),
              items: narrator.paragraphs(output),
              key: 'output',
            });
          },
        })
      : null,
    output && !busy
      ? element('button', {
          class: 'turn-tool', text: 'Copy',
          onclick: (event) => {
            // Held now: an event's currentTarget is gone once it has been handled.
            const button = event.currentTarget;
            navigator.clipboard.writeText(output).then(
              () => { button.textContent = 'Copied'; },
              () => { button.textContent = 'Copy failed'; },
            );
            setTimeout(() => { button.textContent = 'Copy'; }, 1400);
          },
        })
      : null,
    output && !busy
      ? element('button', {
          class: 'turn-tool', text: 'Save to Notes',
          onclick: async (event) => {
            const button = event.currentTarget;
            await invoke('notes:add', {
              kind: 'summary',
              title: (tasks.find((t) => t.id === activeTask)?.name || 'Result')
                + (sourceLabel ? ' — ' + sourceLabel : ''),
              body: output,
              tags: [mode],
            });
            button.textContent = 'Saved';
            setTimeout(() => { button.textContent = 'Save to Notes'; }, 1400);
          },
        })
      : null,
  ].filter(Boolean));
}

async function runTask(task) {
  if (busy) return;
  if (!sourceText.trim()) {
    setOutput('Add some source text first, or use the current page.', true);
    return;
  }
  activeTask = task.id;
  busy = true;
  // The result being read aloud is about to be replaced.
  if (narrator?.state().key === 'output') narrator.stop();
  outputModel = '';
  setOutput('Working…');
  renderTasks();

  let option = null;
  if (task.needsOption === 'language') {
    option = prompt('Translate into which language?', 'Hindi');
    if (!option) { busy = false; setOutput(''); renderTasks(); return; }
  }

  const result = await invoke('workspace:run', {
    mode, task: task.id, text: sourceText, option,
  });
  busy = false;
  if (result?.ok) {
    outputModel = result.model || '';
    setOutput(result.text);
  } else {
    setOutput(result?.error || 'That did not work.', true);
  }
  renderTasks();
}

/* ---- render --------------------------------------------------------------- */

const taskRow = element('div', { class: 'pill-row' });

function renderTasks() {
  taskRow.replaceChildren(...tasks.map((task) => element('button', {
    class: 'pill' + (task.id === activeTask ? ' selected' : ''),
    text: task.name,
    title: task.hint || '',
    disabled: busy ? 'true' : null,
    onclick: () => runTask(task),
  })));
}

function render() {
  content.replaceChildren(...[
    readPage ? readPage.hero : null,
    readPage ? readPage.result : null,
    readPage ? element('h2', { class: 'section-heading', text: 'Or work from your own text' }) : null,

    element('div', { class: 'panel-card' }, [
      element('div', { class: 'panel-card-head' }, [
        icon(isLegal ? 'bookmark' : 'sparkle', { size: 15 }),
        element('span', { class: 'panel-card-title', text: 'Source' }),
        element('button', {
          class: 'pill', text: 'Use the page I was on',
          title: 'The web page in front of you, or the last one you were on',
          onclick: useCurrentPage,
        }),
        element('button', {
          class: 'pill', text: 'Clear',
          onclick: () => {
            sourceText = ''; sourceArea.value = ''; sourceLabel = '';
            updateMeta();
          },
        }),
      ]),
      sourceArea,
      sourceMeta,
    ]),

    element('div', { class: 'panel-card' }, [
      element('div', { class: 'panel-card-head' }, [
        icon('grid', { size: 15 }),
        element('span', { class: 'panel-card-title', text: 'What would you like?' }),
      ]),
      taskRow,
    ]),

    element('div', { class: 'panel-card workspace-output' }, [
      outputHead,
      outputArea,
    ]),

    // Legal output carries a standing caveat: a professional relying on an
    // unverified citation has a real problem, so this is never hidden away.
    isLegal && disclaimer
      ? element('p', { class: 'muted limits-note', text: disclaimer })
      : null,

    narrator ? narrator.dock : null,
  ].filter(Boolean));

  renderTasks();
  renderOutputHead();
  updateMeta();
}

shellApi = window.shell.mount({
  mode,
  title: isLegal ? 'Legal' : 'Student',
  subtitle: isLegal ? 'Indian legal research and drafting' : 'Summarise, quiz, revise',
  content,
});

invoke('workspace:tasks', { mode }).then((result) => {
  tasks = result?.tasks || [];
  disclaimer = result?.disclaimer || '';
  render();
});

// Pushed state changes whenever a tab does, which is also when the page that
// "Read this page" would read can have changed.
onState((next) => {
  if (next?.modes) shellApi?.setState(next.modes);
  readPage?.refresh();
});

narrator?.subscribe(() => { if (output && !busy) renderOutputHead(); });

})();
