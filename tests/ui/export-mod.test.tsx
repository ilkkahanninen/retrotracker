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

/** Open the File ▾ menu and find an item by its visible label. */
function clickFileMenuItem(container: HTMLElement, label: string): void {
  const trigger = container.querySelector<HTMLButtonElement>('.filemenu__button');
  if (!trigger) throw new Error('File menu button not found');
  fireEvent.click(trigger);
  for (const item of container.querySelectorAll<HTMLElement>('.filemenu__item')) {
    if (item.textContent?.includes(label)) {
      fireEvent.click(item);
      return;
    }
  }
  throw new Error(`No file-menu item labelled "${label}"`);
}

describe('export: File ▾ → Export .mod… item', () => {
  it('clicking the item calls io.download with a filename, bytes, and audio/x-mod mime', () => {
    const s = emptySong();
    s.title = 'Demo';
    setSong(s);
    const { container } = render(() => <App />);
    clickFileMenuItem(container, 'Export .mod');
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
    clickFileMenuItem(container, 'Export .mod');
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
    clickFileMenuItem(container, 'Export .mod');
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
