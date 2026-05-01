import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { App } from '../../src/App';
import { setCursor, INITIAL_CURSOR } from '../../src/state/cursor';
import { setSong, setTransport, setPlayPos, clearHistory } from '../../src/state/song';
import { setCurrentSample, setCurrentOctave } from '../../src/state/edit';
import { io } from '../../src/state/io';
import { emptySong } from '../../src/core/mod/format';

function resetState() {
  setSong(null);
  setPlayPos({ order: 0, row: 0 });
  setTransport('idle');
  clearHistory();
  setCursor({ ...INITIAL_CURSOR });
  setCurrentSample(1);
  setCurrentOctave(2);
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

function saveButton(container: HTMLElement): HTMLButtonElement {
  const btn = container.querySelector<HTMLButtonElement>('button[aria-label="Save .mod"]');
  if (!btn) throw new Error('Save button not found');
  return btn;
}

describe('export: Save .mod button', () => {
  it('clicking the button calls io.download with a filename and the serialised bytes', async () => {
    const s = emptySong();
    s.title = 'Demo';
    setSong(s);
    const { container } = render(() => <App />);
    const user = userEvent.setup();
    await user.click(saveButton(container));
    expect(io.download).toHaveBeenCalledTimes(1);
    const [name, bytes] = (io.download as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(name).toBe('Demo.mod');
    expect(bytes).toBeInstanceOf(Uint8Array);
    // 1084 byte header + 1 pattern (1024 bytes) + no sample data = 2108 minimum.
    expect((bytes as Uint8Array).byteLength).toBeGreaterThanOrEqual(1084 + 1024);
  });

  it('the produced bytes round-trip through parseModule (export → parse) cleanly', async () => {
    const s = emptySong();
    s.title = 'Round Trip';
    setSong(s);
    const { container } = render(() => <App />);
    const user = userEvent.setup();
    await user.click(saveButton(container));
    const [, bytes] = (io.download as ReturnType<typeof vi.fn>).mock.calls[0]!;
    // Parse the exported buffer back and check it matches the song's title.
    const { parseModule } = await import('../../src/core/mod/parser');
    const parsed = parseModule(bytes as Uint8Array);
    expect(parsed.title).toBe('Round Trip');
    expect(parsed.signature).toBe('M.K.');
  });

  it('Cmd+S triggers the same export', async () => {
    const s = emptySong();
    s.title = 'Hotkey';
    setSong(s);
    render(() => <App />);
    const user = userEvent.setup();
    await user.keyboard('{Meta>}s{/Meta}');
    expect(io.download).toHaveBeenCalledTimes(1);
    expect((io.download as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe('Hotkey.mod');
  });

  it('still works during playback (export is read-only)', async () => {
    setSong(emptySong());
    const { container } = render(() => <App />);
    const user = userEvent.setup();
    setTransport('playing');
    await user.click(saveButton(container));
    expect(io.download).toHaveBeenCalledTimes(1);
  });
});
