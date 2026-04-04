export function isBluetoothScoAvailable(): boolean {
  return false;
}

export async function startBluetoothSco(): Promise<boolean> {
  return false;
}

export function stopBluetoothSco(): void {}

export function onBluetoothDisconnect(_callback: () => void): () => void {
  return () => {};
}

export function isScoConnected(): boolean {
  return false;
}
