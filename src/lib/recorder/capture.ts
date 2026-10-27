import type { RecordMode } from "./types";

/**
 * What gets recorded: the whole screen (every tab and window) with any sound it
 * makes plus the microphone, or the microphone alone. Pure browser plumbing —
 * no React, no upload — so the provider only deals with state.
 */
const VIDEO_MIMES = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
const AUDIO_MIMES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

export function screenRecordingSupported(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia && typeof MediaRecorder !== "undefined";
}
export function audioRecordingSupported(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";
}

export interface Capture {
  /** One video track (screen mode) and one audio track (sound and mic mixed). */
  stream: MediaStream;
  /** The container/codec this browser records in for the mode. */
  mime: string;
  /** The screen share itself, to notice "Stop sharing" in the browser's own bar. */
  display: MediaStream | null;
  /** Stops every device and the mixer. Safe to call twice. */
  release: () => void;
}

/**
 * Asks for the screen and/or microphone and returns one recordable stream.
 * Throws the browser's own error (NotAllowedError, NotFoundError…) after
 * releasing anything it had already opened.
 */
export async function openCapture(mode: RecordMode): Promise<Capture> {
  const opened: MediaStream[] = [];
  let mixer: AudioContext | null = null;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    for (const s of opened) s.getTracks().forEach((t) => t.stop());
    void mixer?.close().catch(() => undefined);
  };
  try {
    const tracks: MediaStreamTrack[] = [];
    let display: MediaStream | null = null;
    if (mode === "screen") {
      // The WHOLE screen by default — every browser tab and every other window — with any sound it makes.
      display = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 20, max: 30 }, ...({ displaySurface: "monitor" } as object) },
        audio: true,
        ...({ selfBrowserSurface: "include", surfaceSwitching: "include", systemAudio: "include", monitorTypeSurfaces: "include" } as object),
      });
      opened.push(display);
      tracks.push(...display.getVideoTracks());
    }
    let mic: MediaStream | null = null;
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      opened.push(mic);
    } catch (e) {
      if (mode === "audio") throw e;
      mic = null; // a screen recording without a microphone is still a recording
    }
    const audioSources = [display, mic].filter((s): s is MediaStream => !!s && s.getAudioTracks().length > 0);
    if (audioSources.length === 1) tracks.push(...audioSources[0].getAudioTracks());
    else if (audioSources.length > 1) {
      // Mix the screen's sound and the mic into one track so the file has a single audio stream.
      mixer = new AudioContext();
      const dest = mixer.createMediaStreamDestination();
      for (const s of audioSources) mixer.createMediaStreamSource(new MediaStream(s.getAudioTracks())).connect(dest);
      tracks.push(...dest.stream.getAudioTracks());
    }
    const mime = (mode === "audio" ? AUDIO_MIMES : VIDEO_MIMES).find((m) => MediaRecorder.isTypeSupported(m)) ?? (mode === "audio" ? "audio/webm" : "video/webm");
    return { stream: new MediaStream(tracks), mime, display, release };
  } catch (e) {
    release();
    throw e;
  }
}

/** Recorder settings: slides are mostly still, so 1.5 Mbit/s keeps a two-hour meeting near 1.3 GB and still crisp. */
export function recorderOptions(mode: RecordMode, mime: string): MediaRecorderOptions {
  return mode === "audio" ? { mimeType: mime, audioBitsPerSecond: 96_000 } : { mimeType: mime, videoBitsPerSecond: 1_500_000, audioBitsPerSecond: 96_000 };
}
