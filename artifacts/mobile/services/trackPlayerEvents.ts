type Listener = () => void;

const listeners: { play: Listener[]; pause: Listener[]; toggle: Listener[] } = {
  play: [],
  pause: [],
  toggle: [],
};

export function onRemotePlay(cb: Listener): () => void {
  listeners.play.push(cb);
  return () => {
    listeners.play = listeners.play.filter((l) => l !== cb);
  };
}

export function onRemotePause(cb: Listener): () => void {
  listeners.pause.push(cb);
  return () => {
    listeners.pause = listeners.pause.filter((l) => l !== cb);
  };
}

export function onRemoteToggle(cb: Listener): () => void {
  listeners.toggle.push(cb);
  return () => {
    listeners.toggle = listeners.toggle.filter((l) => l !== cb);
  };
}

export function emitRemotePlay(): void {
  console.log("[TrackPlayerEvents] emitRemotePlay, listeners:", listeners.play.length);
  listeners.play.forEach((cb) => cb());
}

export function emitRemotePause(): void {
  console.log("[TrackPlayerEvents] emitRemotePause, listeners:", listeners.pause.length);
  listeners.pause.forEach((cb) => cb());
}

export function emitRemoteToggle(): void {
  console.log("[TrackPlayerEvents] emitRemoteToggle, listeners:", listeners.toggle.length);
  listeners.toggle.forEach((cb) => cb());
}
