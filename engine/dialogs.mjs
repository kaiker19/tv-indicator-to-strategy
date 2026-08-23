export const POPUP_DIALOG_SELECTOR = '[class*=popupDialog],[role=dialog]';

const SAVE_SCRIPT_NAMING_RE = /保存脚本|Save script/i;

export function matchesSaveScriptNamingDialog({ text = '', hasInput = false, visible = true } = {}) {
  return !!visible && !!hasInput && SAVE_SCRIPT_NAMING_RE.test(text);
}

export function saveScriptNamingDialogPredicateSource() {
  return `function(d){return d.offsetWidth>0 && !!d.querySelector('input') && /保存脚本|Save script/i.test(d.textContent || '');}`;
}

export function findSaveScriptNamingDialogExpression() {
  return `Array.from(document.querySelectorAll(${JSON.stringify(POPUP_DIALOG_SELECTOR)})).find(${saveScriptNamingDialogPredicateSource()})`;
}

export function findDiscardUnsavedChangesButtonExpression() {
  return `(function(){
    var dlg = Array.from(document.querySelectorAll(${JSON.stringify(POPUP_DIALOG_SELECTOR)})).find(function(d){
      if (!d.offsetWidth) return false;
      var text = d.textContent || '';
      return /未保存的更改|未保存更改|您想保存|Save script before switching|Do you want to save|unsaved changes/i.test(text);
    });
    if (!dlg) return null;
    return Array.from(dlg.querySelectorAll('button,[role=button]')).find(function(b){
      if (!b.offsetWidth) return false;
      var text = (b.textContent || b.getAttribute('title') || b.getAttribute('aria-label') || '').trim();
      return /^(不保存|否|No|Discard)$/i.test(text) || /^Don.?t save$/i.test(text);
    }) || null;
  })()`;
}

export function findSaveBeforeAddButtonExpression() {
  return `(function(){
    var dlg = Array.from(document.querySelectorAll(${JSON.stringify(POPUP_DIALOG_SELECTOR)})).find(function(d){
      if (!d.offsetWidth || d.querySelector('input')) return false;
      var text = d.textContent || '';
      return /Save this script before adding|未保存更改的脚本无法添加|无法将未保存|无法添加到图表|unsaved.*add/i.test(text);
    });
    if (!dlg) return null;
    return Array.from(dlg.querySelectorAll('button,[role=button]')).find(function(b){
      if (!b.offsetWidth) return false;
      var text = (b.textContent || b.getAttribute('title') || b.getAttribute('aria-label') || '').trim();
      return /^(保存|Save)$/i.test(text) || /保存并添加到图表|Save and add to chart/i.test(text);
    }) || null;
  })()`;
}

export function findPineApplyButtonExpression() {
  return `(function(){
    var root = document.querySelector('[data-name=pine-dialog]') || document;
    return root.querySelector('[data-qa-id="add-script-to-chart"]')
      || root.querySelector('[data-qa-id="update-script-on-chart"]')
      || Array.from(root.querySelectorAll('button,[role=button]')).find(function(b){
        if (!b.offsetWidth) return false;
        var text = (b.textContent || '').trim();
        var title = b.getAttribute('title') || '';
        var aria = b.getAttribute('aria-label') || '';
        return /^(Add to chart|Update on chart)$/i.test(text)
          || /添加到图表|更新到图表|Add to chart|Update on chart/i.test(title + ' ' + aria);
      });
  })()`;
}
