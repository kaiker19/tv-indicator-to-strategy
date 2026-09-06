function normalized(value) {
  return String(value || '').trim();
}

export function assessPineEditorSlot({ title, strategyName, unsavedPrompt = false } = {}) {
  const currentTitle = normalized(title);
  const targetTitle = normalized(strategyName);
  if (unsavedPrompt) {
    return {
      safe: false,
      code: 'PINE_EDITOR_UNSAVED_CHANGES',
      message: 'The current Pine script has unsaved changes; user action is required before creating a fresh strategy slot.',
    };
  }
  if (/^(无标题|Untitled)/i.test(currentTitle)) return { safe: true, mode: 'fresh' };
  if (currentTitle === targetTitle || currentTitle === `[AI] ${targetTitle}`) {
    return { safe: true, mode: 'same_strategy' };
  }
  return {
    safe: false,
    code: 'PINE_EDITOR_WRONG_SCRIPT',
    message: currentTitle
      ? `Refusing to overwrite another saved Pine script: ${currentTitle}`
      : 'Cannot verify a fresh or matching Pine editor slot.',
  };
}
