export function moveAlongFields<F extends readonly string[]>(
  fields: F,
  current: F[number],
  dir: -1 | 1,
  channelCount: number,
  channel: number,
): { field: F[number]; channel: number } {
  const idx = fields.indexOf(current);
  if (dir < 0) {
    if (idx > 0) return { field: fields[idx - 1]!, channel };
    return {
      field: fields[fields.length - 1]!,
      channel: (channel - 1 + channelCount) % channelCount,
    };
  }
  if (idx < fields.length - 1) return { field: fields[idx + 1]!, channel };
  return { field: fields[0]!, channel: (channel + 1) % channelCount };
}

export function cycleChannel(
  channel: number,
  dir: -1 | 1,
  channelCount: number,
): number {
  return dir > 0
    ? (channel + 1) % channelCount
    : (channel - 1 + channelCount) % channelCount;
}
