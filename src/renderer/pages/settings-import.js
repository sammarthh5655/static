'use strict';
(function () {
const { $, element, invoke } = window.page;
const host = $('#import-host');
if (host && window.importPanel) {
  host.append(element('div', { class: 'field' }, [element('div', {}, [
    element('label', { text: 'Bring your stuff' }),
    element('div', { class: 'hint', text: 'Bookmarks, history and homepage from Chrome, Edge, Brave, Opera, Vivaldi, Firefox or Safari on this computer - or from a file another browser exported, such as Safari’s export, which brings passwords too.' }),
  ])]), window.importPanel.build({ element, invoke }));
}
})();
