import { app, Menu, type BrowserWindow, type ContextMenuParams, type MenuItemConstructorOptions } from 'electron';

type TextSpot = Pick<ContextMenuParams, 'misspelledWord' | 'dictionarySuggestions' | 'isEditable' | 'selectionText' | 'editFlags'>;

/**
 * Right-click menu for text: spelling corrections and "Add to dictionary" on a
 * misspelled word, then the usual editing commands. Null where there's no text
 * to act on, so right-clicking empty space does nothing.
 */
export function textMenuTemplate(spot: TextSpot, actions: { replace: (word: string) => void; learn: (word: string) => void }): MenuItemConstructorOptions[] | null {
  if (!spot.isEditable && !spot.selectionText.trim()) return null;
  const items: MenuItemConstructorOptions[] = [];
  if (spot.misspelledWord) {
    const suggestions = spot.dictionarySuggestions.slice(0, 5);
    if (suggestions.length) for (const word of suggestions) items.push({ label: word, click: () => actions.replace(word) });
    else items.push({ label: 'No suggestions', enabled: false });
    items.push({ type: 'separator' }, { label: 'Add to dictionary', click: () => actions.learn(spot.misspelledWord) }, { type: 'separator' });
  }
  if (spot.isEditable) {
    items.push(
      { role: 'cut', enabled: spot.editFlags.canCut },
      { role: 'copy', enabled: spot.editFlags.canCopy },
      { role: 'paste', enabled: spot.editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll' },
    );
  } else {
    items.push({ role: 'copy' });
  }
  return items;
}

/**
 * Chromium checks spelling with the Windows spell checker (red underline, no
 * dictionary download); Electron has no right-click menu of its own, so this adds one.
 */
export function setUpSpelling(win: BrowserWindow): void {
  const session = win.webContents.session;
  try {
    const available = session.availableSpellCheckerLanguages;
    const pick = [app.getLocale(), 'en-US', 'en-GB'].find((l) => available.includes(l));
    if (pick) session.setSpellCheckerLanguages([pick]);
  } catch (err) {
    console.error('[nest] could not set a spelling language:', (err as Error).message);
  }
  win.webContents.on('context-menu', (_event, params) => {
    const template = textMenuTemplate(params, {
      replace: (word) => win.webContents.replaceMisspelling(word),
      learn: (word) => session.addWordToSpellCheckerDictionary(word),
    });
    if (template) Menu.buildFromTemplate(template).popup({ window: win });
  });
}
