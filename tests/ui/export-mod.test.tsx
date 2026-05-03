import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, fireEvent } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { App } from '../../src/App';
import { setCursor, INITIAL_CURSOR } from '../../src/state/cursor';
import { setSong, setTransport, setPlayPos, clearHistory, setDirty } from '../../src/state/song';
import { setCurrentSample, setCurrentOctave } from '../../src/state/edit';
import { setView } from '../../src/state/view';
import { io } from '../../src/state/io';
import { emptySong } from '../../src/core/mod/format';
import { clearSession } from '../../src/state/persistence';

function resetState() {
  setSong(null);
  setPlayPos({ order: 0, row: 0 });
  setTransport('idle');
  clearHistory();
  setCursor({ ...INITIAL_CURSOR });
  setCurrentSample(1);
  setCurrentOctave(2);
  setDirty(false);
  setView('pattern');
  clearSession();
}

const realDownload = io.download;

beforeEach(() => {
  resetState();
  io.download = vi.fn();
});
afterEach(() => {
  cleanup();
  io.download = realDownload;
  resetState();
});

/** Open a header dropdown by its trigger label and click an item. The
 *  page now has two menu triggers (File / Edit), so callers must say
 *  which one they want. */
function clickMenuItem(container: HTMLElement, menu: 'File' | 'Edit', label: string): void {
  let trigger: HTMLButtonElement | null = null;
  for (const btn of container.querySelectorAll<HTMLButtonElement>('.menu__button')) {
    if (btn.textContent?.startsWith(menu)) { trigger = btn; break; }
  }
  if (!trigger) throw new Error(`${menu} menu button not found`);
  fireEvent.click(trigger);
  for (const item of container.querySelectorAll<HTMLElement>('.menu__item')) {
    if (item.textContent?.includes(label)) {
      fireEvent.click(item);
      return;
    }
  }
  throw new Error(`No ${menu}-menu item labelled "${label}"`);
}

describe('export: File ▾ → Export .mod… item', () => {
  it('clicking the item calls io.download with a filename, bytes, and audio/x-mod mime', () => {
    const s = emptySong();
    s.title = 'Demo';
    setSong(s);
    const { container } = render(() => <App />);
    clickMenuItem(container, 'File', 'Export .mod');
    expect(io.download).toHaveBeenCalledTimes(1);
    const [name, bytes, mime] = (io.download as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(name).toBe('Demo.mod');
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(mime).toBe('audio/x-mod');
    // 1084 byte header + 1 pattern (1024 bytes) + no sample data = 2108 minimum.
    expect((bytes as Uint8Array).byteLength).toBeGreaterThanOrEqual(1084 + 1024);
  });

  it('the produced bytes round-trip through parseModule (export → parse) cleanly', async () => {
    const s = emptySong();
    s.title = 'Round Trip';
    setSong(s);
    const { container } = render(() => <App />);
    clickMenuItem(container, 'File', 'Export .mod');
    const [, bytes] = (io.download as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const { parseModule } = await import('../../src/core/mod/parser');
    const parsed = parseModule(bytes as Uint8Array);
    expect(parsed.title).toBe('Round Trip');
    expect(parsed.signature).toBe('M.K.');
  });

  it('still works during playback (export is read-only)', () => {
    setSong(emptySong());
    const { container } = render(() => <App />);
    setTransport('playing');
    clickMenuItem(container, 'File', 'Export .mod');
    expect(io.download).toHaveBeenCalledTimes(1);
  });

});

describe('Cmd+S now saves the .retro project (not .mod export)', () => {
  it('Cmd+S calls io.download with a .retro filename', async () => {
    const s = emptySong();
    s.title = 'Hotkey';
    setSong(s);
    render(() => <App />);
    const user = userEvent.setup();
    await user.keyboard('{Meta>}s{/Meta}');
    expect(io.download).toHaveBeenCalledTimes(1);
    const [name, , mime] = (io.download as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(name).toMatch(/\.retro$/);
    expect(mime).toBe('application/json');
  });
});
