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

const mode = window.WORKSPACE_MODE || 'student';
const isLegal = mode === 'legal';

let tasks = [];
let disclaimer = '';
let activeTask = null;
let sourceText = '';
let sourceLabel = '';
let output = '';
let outputModel = '';
let busy = false;
let shellApi = null;

const content = element('div');

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
  outputArea.textContent = text;
  outputArea.classList.toggle('error', isError);
  renderOutputHead();
}

function renderOutputHead() {
  outputHead.replaceChildren(...[
    element('span', {
      class: 'workspace-output-title',
      text: activeTask ? (tasks.find((t) => t.id === activeTask)?.name || 'Result') : 'Result',
    }),
    outputModel ? element('span', { class: 'muted', text: outputModel }) : null,
    output && !busy
      ? element('button', {
          class: 'turn-tool', text: 'Copy',
          onclick: (event) => {
            navigator.clipboard.writeText(output).then(
              () => { event.currentTarget.textContent = 'Copied'; },
              () => { event.currentTarget.textContent = 'Copy failed'; },
            );
            setTimeout(() => { event.currentTarget.textContent = 'Copy'; }, 1400);
          },
        })
      : null,
    output && !busy
      ? element('button', {
          class: 'turn-tool', text: 'Save to Notes',
          onclick: async (event) => {
            await invoke('notes:add', {
              kind: 'summary',
              title: (tasks.find((t) => t.id === activeTask)?.name || 'Result')
                + (sourceLabel ? ' — ' + sourceLabel : ''),
              body: output,
              tags: [mode],
            });
            event.currentTarget.textContent = 'Saved';
            setTimeout(() => { event.currentTarget.textContent = 'Save to Notes'; }, 1400);
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
    element('div', { class: 'panel-card' }, [
      element('div', { class: 'panel-card-head' }, [
        icon(isLegal ? 'bookmark' : 'sparkle', { size: 15 }),
        element('span', { class: 'panel-card-title', text: 'Source' }),
        element('button', {
          class: 'pill', text: 'Use current page',
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

onState((next) => { if (next?.modes) shellApi?.setState(next.modes); });

})();
