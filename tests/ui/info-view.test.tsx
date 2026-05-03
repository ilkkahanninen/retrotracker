import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, fireEvent } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { App } from '../../src/App';
import { setCursor, INITIAL_CURSOR } from '../../src/state/cursor';
import { setSong, setTransport, setPlayPos, clearHistory, song, setDirty } from '../../src/state/song';
import { setCurrentSample, setCurrentOctave, setEditStep } from '../../src/state/edit';
import { setView, view } from '../../src/state/view';
import { infoText, setInfoText } from '../../src/state/info';
import { io } from '../../src/state/io';
import { emptySong } from '../../src/core/mod/format';
import { clearSession } from '../../src/state/persistence';
import { parseModule } from '../../src/core/mod/parser';
import { writeModule } from '../../src/core/mod/writer';

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
  setInfoText('');
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

describe('Info view: tab + F4 routing', () => {
  it('clicking the Info viewtab switches to the info view', async () => {
    setSong(emptySong());
    const { container } = render(() => <App />);
    const tab = container.querySelector<HTMLButtonElement>('.viewtabs button[aria-selected="false"][title*="Info"]')
      ?? Array.from(container.querySelectorAll<HTMLButtonElement>('.viewtabs button'))
        .find((b) => b.textContent === 'Info')!;
    fireEvent.click(tab);
    expect(view()).toBe('info');
    expect(container.querySelector('.infoview')).toBeTruthy();
  });

  it('F4 toggles to the info view', async () => {
    setSong(emptySong());
    render(() => <App />);
    const user = userEvent.setup();
    await user.keyboard('{F4}');
    expect(view()).toBe('info');
  });

  it('the info pane is hidden when not the active view', () => {
    setSong(emptySong());
    setView('pattern');
    const { container } = render(() => <App />);
    const wrap = container.querySelector('.infoview-wrapper')!;
    expect(wrap.classList.contains('view-hidden')).toBe(true);
  });
});

describe('Info view: editing fields', () => {
  it('typing in the song title input commits to song.title (round-trip)', async () => {
    setSong(emptySong());
    setView('info');
    const { container } = render(() => <App />);
    const input = container.querySelector<HTMLInputElement>('.infoview__field:nth-of-type(1) .infoview__input')!;
    const user = userEvent.setup();
    await user.click(input);
    await user.type(input, 'Hello');
    expect(song()!.title).toBe('Hello');
  });

  it('typing in the filename input updates the export filename', async () => {
    const s = emptySong();
    s.title = 'IgnoreMe';
    setSong(s);
    setView('info');
    const { container } = render(() => <App />);
    const inputs = container.querySelectorAll<HTMLInputElement>('.infoview__input');
    const filenameInput = inputs[1]!;
    const user = userEvent.setup();
    await user.clear(filenameInput);
    await user.type(filenameInput, 'override.mod');
    // Now export and check the chosen filename comes from the input (not the title).
    setView('pattern');
    const file = container.querySelector<HTMLButtonElement>('.menu__button')!;
    fireEvent.click(file);
    let exportItem: HTMLElement | null = null;
    for (const item of container.querySelectorAll<HTMLElement>('.menu__item')) {
      if (item.textContent?.includes('Export .mod')) { exportItem = item; break; }
    }
    fireEvent.click(exportItem!);
    const [name] = (io.download as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(name).toBe('override.mod');
  });

  it('typing in the info-text textarea updates the infoText signal', async () => {
    setSong(emptySong());
    setView('info');
    const { container } = render(() => <App />);
    const textarea = container.querySelector<HTMLTextAreaElement>('.infoview__textarea')!;
    const user = userEvent.setup();
    await user.click(textarea);
    await user.type(textarea, 'hello{Enter}world');
    expect(infoText()).toBe('hello\nworld');
  });
});

describe('Info view: export-time sample-name override', () => {
  it('exports info text into the sample-name slots, one line per slot', async () => {
    const s = emptySong();
    s.title = 'Demo';
    setSong(s);
    setInfoText('made by claude\nfor ilkka\n2026');
    const { container } = render(() => <App />);
    // Open File ▾ and click Export.
    fireEvent.click(container.querySelector<HTMLButtonElement>('.menu__button')!);
    let exportItem: HTMLElement | null = null;
    for (const item of container.querySelectorAll<HTMLElement>('.menu__item')) {
      if (item.textContent?.includes('Export .mod')) { exportItem = item; break; }
    }
    fireEvent.click(exportItem!);
    const [, bytes] = (io.download as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const parsed = parseModule(bytes as Uint8Array);
    expect(parsed.samples[0]!.name).toBe('made by claude');
    expect(parsed.samples[1]!.name).toBe('for ilkka');
    expect(parsed.samples[2]!.name).toBe('2026');
    expect(parsed.samples[3]!.name).toBe('');
  });

  it('word-wraps lines longer than 22 chars across additional sample slots', async () => {
    const s = emptySong();
    setSong(s);
    // 27 chars; should wrap on the space at column 21 ("hello world this is a") /
    // remainder ("long line").
    setInfoText('hello world this is a long line');
    const { container } = render(() => <App />);
    fireEvent.click(container.querySelector<HTMLButtonElement>('.menu__button')!);
    for (const item of container.querySelectorAll<HTMLElement>('.menu__item')) {
      if (item.textContent?.includes('Export .mod')) { fireEvent.click(item); break; }
    }
    const [, bytes] = (io.download as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const parsed = parseModule(bytes as Uint8Array);
    expect(parsed.samples[0]!.name).toBe('hello world this is a');
    expect(parsed.samples[1]!.name).toBe('long line');
  });

  it('hard-breaks a single word longer than the 22-char field', async () => {
    const s = emptySong();
    setSong(s);
    setInfoText('a'.repeat(40));
    const { container } = render(() => <App />);
    fireEvent.click(container.querySelector<HTMLButtonElement>('.menu__button')!);
    for (const item of container.querySelectorAll<HTMLElement>('.menu__item')) {
      if (item.textContent?.includes('Export .mod')) { fireEvent.click(item); break; }
    }
    const [, bytes] = (io.download as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const parsed = parseModule(bytes as Uint8Array);
    expect(parsed.samples[0]!.name).toBe('a'.repeat(22));
    expect(parsed.samples[1]!.name).toBe('a'.repeat(18));
  });

  it('round-trips through .mod export → import: info text restored from sample names', async () => {
    // Round-trip via writeModule so the sample names are stamped, then
    // parseModule + the import path's `infoTextFromSampleNames` derivation.
    const s = emptySong();
    s.samples[0]!.name = 'made by claude';
    s.samples[1]!.name = 'for ilkka';
    s.samples[2]!.name = '2026';
    const bytes = writeModule(s);

    setSong(emptySong());
    const { container } = render(() => <App />);
    const file = new File([bytes.slice().buffer], 'demo.mod', { type: 'audio/x-mod' });
    const input = container.querySelector<HTMLInputElement>(
      'input[type="file"][accept*=".retro"]',
    )!;
    const user = userEvent.setup();
    await user.upload(input, file);
    await new Promise((r) => setTimeout(r, 0));

    expect(infoText()).toBe('made by claude\nfor ilkka\n2026');
  });

  it('on import, trailing empty sample names are dropped from the info text', async () => {
    const s = emptySong();
    s.samples[0]!.name = 'first';
    s.samples[2]!.name = 'third'; // gap at slot 1 should survive
    const bytes = writeModule(s);

    setSong(emptySong());
    const { container } = render(() => <App />);
    const file = new File([bytes.slice().buffer], 'gap.mod', { type: 'audio/x-mod' });
    const input = container.querySelector<HTMLInputElement>(
      'input[type="file"][accept*=".retro"]',
    )!;
    const user = userEvent.setup();
    await user.upload(input, file);
    await new Promise((r) => setTimeout(r, 0));

    expect(infoText()).toBe('first\n\nthird');
  });

  it('leaves sample names alone when the info text is empty', async () => {
    const s = emptySong();
    s.samples[0]!.name = 'kick';
    s.samples[1]!.name = 'snare';
    setSong(s);
    setInfoText('');
    const { container } = render(() => <App />);
    fireEvent.click(container.querySelector<HTMLButtonElement>('.menu__button')!);
    for (const item of container.querySelectorAll<HTMLElement>('.menu__item')) {
      if (item.textContent?.includes('Export .mod')) { fireEvent.click(item); break; }
    }
    const [, bytes] = (io.download as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const parsed = parseModule(bytes as Uint8Array);
    expect(parsed.samples[0]!.name).toBe('kick');
    expect(parsed.samples[1]!.name).toBe('snare');
  });
});
