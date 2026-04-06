export async function setupTrackPlayer(
  _onPlay: () => void,
  _onPause: () => void,
  _onToggle: () => void
): Promise<boolean> {
  return false;
}

export async function pauseSilentTrack(): Promise<void> {}

export async function resumeSilentTrack(): Promise<void> {}

export async function destroyTrackPlayer(): Promise<void> {}
