import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, fireEvent } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { App } from '../../src/App';
import { setCursor, INITIAL_CURSOR, cursor } from '../../src/state/cursor';
import {
  setSong, setTransport, setPlayPos, clearHistory, song, dirty, setDirty,
} from '../../src/state/song';
import {
  setCurrentSample, setCurrentOctave, setEditStep, currentSample, editStep,
} from '../../src/state/edit';
import { setView, view } from '../../src/state/view';
import { io } from '../../src/state/io';
import {
  clearSession, projectToBytes,
} from '../../src/state/persistence';
import { commitEdit } from '../../src/state/song';
import { emptySong } from '../../src/core/mod/format';

function resetState() {
  setSong(null);
  setPlayPos({ order: 0, row: 0 });
  setTransport('idle');
  clearHistory();
  setCursor({ ...INITIAL_CURSOR });
  setCurrentSample(1);
  setCurrentOctave(2);
  setEditStep(1);
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
  vi.restoreAllMocks();
});

function clickItem(container: HTMLElement, label: string): void {
  const trigger = container.querySelector<HTMLButtonElement>('.filemenu__button')!;
  fireEvent.click(trigger);
  for (const item of container.querySelectorAll<HTMLElement>('.filemenu__item')) {
    if (item.textContent?.includes(label)) {
      fireEvent.click(item);
      return;
    }
  }
  throw new Error(`No file-menu item labelled "${label}"`);
}

describe('FileMenu: dropdown behaviour', () => {
  it('opens on click and closes when an item fires', () => {
    const { container } = render(() => <App />);
    const trigger = container.querySelector<HTMLButtonElement>('.filemenu__button')!;
    expect(container.querySelector('.filemenu__menu')).toBeNull();
    fireEvent.click(trigger);
    expect(container.querySelector('.filemenu__menu')).not.toBeNull();
    // Click the New item — menu should close after the action.
    const newItem = Array.from(
      container.querySelectorAll<HTMLElement>('.filemenu__item'),
    ).find((i) => i.textContent?.includes('New'))!;
    fireEvent.click(newItem);
    expect(container.querySelector('.filemenu__menu')).toBeNull();
  });

  it('lists New, Open…, Save…, Export .mod… in order', () => {
    const { container } = render(() => <App />);
    fireEvent.click(container.querySelector<HTMLButtonElement>('.filemenu__button')!);
    const labels = Array.from(
      container.querySelectorAll<HTMLElement>('.filemenu__item .filemenu__label'),
    ).map((el) => el.textContent);
    expect(labels).toEqual(['New', 'Open…', 'Save…', 'Export .mod…']);
  });
});

describe('File menu: New', () => {
  it('replaces the song with a blank one and clears dirty', () => {
    const s = emptySong();
    s.title = 'Stale';
    setSong(s);
    setDirty(false);
    const { container } = render(() => <App />);
    clickItem(container, 'New');
    expect(song()!.title).toBe('');
    expect(dirty()).toBe(false);
  });

  it('prompts via window.confirm when the project is dirty', () => {
    setSong(emptySong());
    const { container } = render(() => <App />);
    // Simulate an edit so dirty=true.
    commitEdit((s) => ({ ...s, title: 'edited' }));
    expect(dirty()).toBe(true);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    clickItem(container, 'New');
    expect(confirmSpy).toHaveBeenCalled();
    // User said no → song stays.
    expect(song()!.title).toBe('edited');
  });

  it('proceeds when the user confirms', () => {
    setSong(emptySong());
    const { container } = render(() => <App />);
    commitEdit((s) => ({ ...s, title: 'edited' }));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    clickItem(container, 'New');
    expect(song()!.title).toBe('');
    expect(dirty()).toBe(false);
  });
});

describe('File menu: Save… (.retro)', () => {
  it('downloads a .retro JSON with the application/json mime', () => {
    const s = emptySong();
    s.title = 'Demo';
    setSong(s);
    setCursor({ order: 0, row: 5, channel: 2, field: 'effectHi' });
    setCurrentSample(7);
    setEditStep(3);
    setView('sample');
    const { container } = render(() => <App />);
    clickItem(container, 'Save…');
    expect(io.download).toHaveBeenCalledTimes(1);
    const [name, bytes, mime] = (io.download as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(name).toBe('Demo.retro');
    expect(mime).toBe('application/json');
    // Validate the JSON shape.
    const text = new TextDecoder('utf-8').decode(bytes as Uint8Array);
    const parsed = JSON.parse(text);
    expect(parsed.v).toBe(1);
    expect(parsed.cursor).toEqual({ order: 0, row: 5, channel: 2, field: 'effectHi' });
    expect(parsed.currentSample).toBe(7);
    expect(parsed.editStep).toBe(3);
    expect(parsed.view).toBe('sample');
  });

  it('Save clears dirty', () => {
    setSong(emptySong());
    const { container } = render(() => <App />);
    commitEdit((s) => ({ ...s, title: 'x' }));
    expect(dirty()).toBe(true);
    clickItem(container, 'Save…');
    expect(dirty()).toBe(false);
  });
});

describe('Open: file-input sniff routes by extension', () => {
  it('a .retro upload restores cursor / view / current sample / edit step', async () => {
    setSong(emptySong());
    const { container } = render(() => <App />);
    const user = userEvent.setup();

    // Build a project payload to upload.
    const s = emptySong();
    s.title = 'Loaded';
    const projectBytes = projectToBytes({
      song: s,
      filename: 'Loaded.retro',
      view: 'sample',
      cursor: { order: 0, row: 11, channel: 1, field: 'sampleLo' },
      currentSample: 9, currentOctave: 3, editStep: 4,
    });
    const file = new File([projectBytes], 'Loaded.retro', { type: 'application/json' });

    const input = container.querySelector<HTMLInputElement>(
      'input[type="file"][accept*=".retro"]',
    )!;
    await user.upload(input, file);

    // Wait a microtask for the async loadFile to resolve.
    await new Promise((r) => setTimeout(r, 0));

    expect(song()!.title).toBe('Loaded');
    expect(view()).toBe('sample');
    expect(cursor()).toEqual({ order: 0, row: 11, channel: 1, field: 'sampleLo' });
    expect(currentSample()).toBe(9);
    expect(editStep()).toBe(4);
  });
});
