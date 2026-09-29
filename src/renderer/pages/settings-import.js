'use strict';
(function () {
const { $, element, invoke } = window.page;
const host = $('#import-host');
if (host && window.importPanel) {
  host.append(element('div', { class: 'field' }, [element('div', {}, [
    element('label', { text: 'Bring your stuff' }),
    element('div', { class: 'hint', text: 'Bookmarks, history and homepage from Chrome, Edge, Brave, Opera, Vivaldi or Firefox on this computer.' }),
  ])]), window.importPanel.build({ element, invoke }));
}
})();
