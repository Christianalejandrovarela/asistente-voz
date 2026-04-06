import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system/legacy";
import { Platform } from "react-native";

import { addMessage, purgeOldMessages } from "@/services/conversationDb";

export interface BufferSegment {
  uri: string;
  startedAt: number;
  text?: string;
}

const SEGMENT_DURATION_MS = 30_000;
const MAX_BUFFER_MS = 10 * 60 * 1000;
const BUFFER_DIR = `${FileSystem.cacheDirectory}rolling_buffer/`;

function generateId(): string {
  return `${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

class RollingBufferManagerImpl {
  private segments: BufferSegment[] = [];
  private running = false;
  private paused = false;
  private currentRecording: Audio.Recording | null = null;
  private currentSegmentStartedAt = 0;
  private segmentTimer: ReturnType<typeof setTimeout> | null = null;
  private transcribedTexts: { text: string; timestamp: number }[] = [];

  get totalDurationMs(): number {
    if (this.segments.length === 0) return 0;
    const oldest = this.segments[0].startedAt;
    const newest = this.segments[this.segments.length - 1].startedAt;
    return newest - oldest + SEGMENT_DURATION_MS;
  }

  get isRunning(): boolean {
    return this.running && !this.paused;
  }

  getContextText(): string {
    const cutoff = Date.now() - MAX_BUFFER_MS;
    const recent = this.transcribedTexts.filter((t) => t.timestamp >= cutoff);
    return recent.map((t) => t.text).join(" ");
  }

  async start(): Promise<boolean> {
    if (Platform.OS === "web") return false;
    if (this.running) return true;

    const { status } = await Audio.requestPermissionsAsync();
    if (status !== "granted") {
      console.warn("[RollingBuffer] Microphone permission denied");
      return false;
    }

    await this._ensureBufferDir();
    await this._rehydrateAndClean();
    this.running = true;
    this.paused = false;
    await this._startSegment();
    return true;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.paused = false;
    this._clearTimer();
    await this._stopAndDeleteCurrentRecording();
    this.segments = [];
    this.transcribedTexts = [];
    await this._wipeBufferDir();
  }

  async pause(): Promise<void> {
    if (!this.running || this.paused) return;
    this.paused = true;
    this._clearTimer();
    await this._stopAndSaveCurrentRecording();
  }

  async resume(): Promise<void> {
    if (!this.running || !this.paused) return;
    this.paused = false;
    await this._startSegment();
  }

  getSegments(): BufferSegment[] {
    return [...this.segments];
  }

  private async _ensureBufferDir(): Promise<void> {
    try {
      const info = await FileSystem.getInfoAsync(BUFFER_DIR);
      if (!info.exists) {
        await FileSystem.makeDirectoryAsync(BUFFER_DIR, { intermediates: true });
      }
    } catch {}
  }

  private _clearTimer(): void {
    if (this.segmentTimer) {
      clearTimeout(this.segmentTimer);
      this.segmentTimer = null;
    }
  }

  private _makeSegmentPath(): string {
    return `${BUFFER_DIR}seg_${Date.now()}.m4a`;
  }

  private async _startSegment(): Promise<void> {
    if (!this.running || this.paused) return;

    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
      });

      // Re-check after every await: pause() may have been called while we waited.
      if (!this.running || this.paused) return;

      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.LOW_QUALITY
      );

      // Re-check again: if we were paused while createAsync() was in flight,
      // release the recording immediately so the voice loop can have the mic.
      if (!this.running || this.paused) {
        try { await recording.stopAndUnloadAsync(); } catch {}
        return;
      }

      this.currentRecording = recording;
      this.currentSegmentStartedAt = Date.now();

      this.segmentTimer = setTimeout(async () => {
        if (!this.running || this.paused) return;
        await this._finishSegment();
      }, SEGMENT_DURATION_MS);
    } catch (err) {
      console.warn("[RollingBuffer] Failed to start segment:", err);
      this.currentRecording = null;
      // Only retry if still active — do NOT retry while paused.
      if (this.running && !this.paused) {
        this.segmentTimer = setTimeout(() => {
          void this._startSegment();
        }, 5_000);
      }
    }
  }

  private async _finishSegment(): Promise<void> {
    try {
      const recording = this.currentRecording;
      if (!recording) return;

      const startedAt = this.currentSegmentStartedAt;
      await recording.stopAndUnloadAsync();
      const tempUri = recording.getURI();
      this.currentRecording = null;

      if (tempUri) {
        const destPath = this._makeSegmentPath();
        await FileSystem.moveAsync({ from: tempUri, to: destPath });
        this.segments.push({ uri: destPath, startedAt });

        void this._transcribeAndStore(destPath, startedAt);

        await this._pruneOldSegments();
      }
    } catch (err) {
      console.warn("[RollingBuffer] Error finishing segment:", err);
      this.currentRecording = null;
    }

    if (this.running && !this.paused) {
      await this._startSegment();
    }
  }

  private async _stopAndSaveCurrentRecording(): Promise<void> {
    try {
      if (this.currentRecording) {
        const startedAt = this.currentSegmentStartedAt;
        await this.currentRecording.stopAndUnloadAsync();
        const uri = this.currentRecording.getURI();
        this.currentRecording = null;

        if (uri) {
          const destPath = this._makeSegmentPath();
          await FileSystem.moveAsync({ from: uri, to: destPath });
          this.segments.push({ uri: destPath, startedAt });
          void this._transcribeAndStore(destPath, startedAt);
        }
      }
    } catch {
      this.currentRecording = null;
    }
  }

  private async _stopAndDeleteCurrentRecording(): Promise<void> {
    try {
      if (this.currentRecording) {
        await this.currentRecording.stopAndUnloadAsync();
        const uri = this.currentRecording.getURI();
        this.currentRecording = null;
        if (uri) {
          await FileSystem.deleteAsync(uri, { idempotent: true });
        }
      }
    } catch {
      this.currentRecording = null;
    }
  }

  private async _transcribeAndStore(audioUri: string, timestamp: number): Promise<void> {
    try {
      const base64Audio = await FileSystem.readAsStringAsync(audioUri, {
        encoding: "base64",
      });

      await FileSystem.deleteAsync(audioUri, { idempotent: true });
      this.segments = this.segments.filter((s) => s.uri !== audioUri);

      const domain = process.env.EXPO_PUBLIC_DOMAIN;
      const apiUrl = domain
        ? `https://${domain}/api/voice/transcribe`
        : "http://localhost:8080/api/voice/transcribe";

      const response = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audio: base64Audio,
          language: "es",
        }),
      });

      if (!response.ok) return;

      const data = (await response.json()) as { text: string };
      const text = data.text?.trim();
      if (!text || text.length < 2) return;

      this.transcribedTexts.push({ text, timestamp });

      const cutoff = Date.now() - MAX_BUFFER_MS;
      this.transcribedTexts = this.transcribedTexts.filter((t) => t.timestamp >= cutoff);

      await addMessage({
        id: generateId(),
        role: "user",
        text: `[contexto] ${text}`,
        timestamp,
      });
    } catch (err) {
      console.warn("[RollingBuffer] Transcription failed:", err);
      try {
        await FileSystem.deleteAsync(audioUri, { idempotent: true });
      } catch {}
      this.segments = this.segments.filter((s) => s.uri !== audioUri);
    }
  }

  private async _pruneOldSegments(): Promise<void> {
    const cutoff = Date.now() - MAX_BUFFER_MS;
    const toDelete: BufferSegment[] = [];
    const toKeep: BufferSegment[] = [];

    for (const seg of this.segments) {
      if (seg.startedAt < cutoff) {
        toDelete.push(seg);
      } else {
        toKeep.push(seg);
      }
    }

    this.segments = toKeep;
    this.transcribedTexts = this.transcribedTexts.filter((t) => t.timestamp >= cutoff);

    await Promise.all(
      toDelete.map((seg) =>
        FileSystem.deleteAsync(seg.uri, { idempotent: true }).catch(() => {})
      )
    );
  }

  private async _rehydrateAndClean(): Promise<void> {
    try {
      const files = await FileSystem.readDirectoryAsync(BUFFER_DIR);
      const cutoff = Date.now() - MAX_BUFFER_MS;
      const kept: BufferSegment[] = [];

      await Promise.all(
        files.map(async (name: string) => {
          const match = name.match(/^seg_(\d+)\.m4a$/);
          if (!match) return;
          const ts = parseInt(match[1], 10);
          const uri = `${BUFFER_DIR}${name}`;
          if (ts < cutoff) {
            await FileSystem.deleteAsync(uri, { idempotent: true });
          } else {
            kept.push({ uri, startedAt: ts });
          }
        })
      );

      kept.sort((a, b) => a.startedAt - b.startedAt);
      this.segments = kept;
    } catch {
      this.segments = [];
    }
  }

  private async _wipeBufferDir(): Promise<void> {
    try {
      await FileSystem.deleteAsync(BUFFER_DIR, { idempotent: true });
    } catch {}
  }
}

export const RollingBufferManager = new RollingBufferManagerImpl();
