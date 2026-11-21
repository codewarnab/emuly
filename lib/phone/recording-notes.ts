// WebVTT for the notes of a screen recording (GET /v1/phones/:id/recording/notes?format=vtt).
// Each note shows until the next note, or for DEFAULT_CUE_S after the last one (cut at the video end).

export type RecordingNote = { t_s: number; text: string };

const DEFAULT_CUE_S = 3;

/** 61.5 -> "00:01:01.500" */
export function vttTime(seconds: number) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`;
}

export function notesVtt(notes: RecordingNote[], durationMs?: number) {
  const end = durationMs === undefined ? Infinity : durationMs / 1000;
  const cues = notes.map((note, index) => {
    const next = notes[index + 1]?.t_s ?? Math.min(note.t_s + DEFAULT_CUE_S, Math.max(end, note.t_s + 0.5));
    const stop = Math.max(next, note.t_s + 0.1);
    // A blank line or "-->" inside a cue would end it or break it.
    const text = note.text.replace(/\r?\n\s*\r?\n/g, "\n").replaceAll("-->", "->");
    return `${index + 1}\n${vttTime(note.t_s)} --> ${vttTime(stop)}\n${text}`;
  });
  return ["WEBVTT", ...cues].join("\n\n") + "\n";
}
