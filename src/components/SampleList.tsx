import { For, Show, type Component } from 'solid-js';
import type { Song } from '../core/mod/types';
import { currentSample } from '../state/edit';

interface Props {
  song: Song | null;
  onSelect: (index1Based: number) => void;
}

/**
 * The 31-slot sample list that's shared across the pattern and sample views.
 * Reading current selection from `currentSample()` (rather than props) lets
 * the same instance update reactively without the parent passing it through.
 */
export const SampleList: Component<Props> = (props) => {
  return (
    <Show when={props.song} fallback={<p class="placeholder">No song loaded</p>}>
      {(s) => (
        <ol>
          <For each={s().samples}>
            {(sample, i) => (
              <li
                classList={{
                  'sample--empty':   sample.lengthWords === 0,
                  'sample--current': currentSample() === i() + 1,
                }}
                onClick={() => props.onSelect(i() + 1)}
                title={`Select sample ${i() + 1}`}
              >
                <span class="num">{String(i() + 1).padStart(2, '0')}</span>
                <span class="name">{sample.name || '—'}</span>
              </li>
            )}
          </For>
        </ol>
      )}
    </Show>
  );
};
