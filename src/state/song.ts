import { createStore } from 'solid-js/store';
import { emptySong } from '../core/mod/format';
import type { Song } from '../core/mod/types';

export const [song, setSong] = createStore<Song>(emptySong());
