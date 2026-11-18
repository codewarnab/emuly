// Plays the phone's sound in the browser. The runner sends scrcpy's Opus packets on the video
// WebSocket (flag AUDIO, see scrcpy-protocol.mjs). WebCodecs decodes them, and Web Audio plays the
// PCM with a short buffer, so the sound stays about 100 ms behind the phone.
//
// Browsers play sound only after a user gesture. So the player starts muted, and start() must run
// inside a click handler: it creates the AudioContext there.

const LEAD_S = 0.06;      // the buffer that absorbs network jitter
const MAX_LAG_S = 0.25;   // more queued sound than this: drop it and continue from now, as the video does

type AudioPacket = { config: boolean; pts: number; data: Uint8Array };

export function audioSupported() {
  return typeof window !== "undefined" && "AudioDecoder" in window && "AudioContext" in window;
}

export function createPhoneAudio() {
  let context: AudioContext | null = null;
  let decoder: AudioDecoder | null = null;
  let head: Uint8Array | null = null;
  let playAt = 0;

  function configure() {
    if (!context || !head) return;
    if (decoder && decoder.state !== "closed") decoder.close();
    decoder = new AudioDecoder({ output: play, error: () => { decoder = null; } });
    // The OpusHead is the codec description (WebCodecs Opus registration).
    decoder.configure({ codec: "opus", sampleRate: 48_000, numberOfChannels: head[9] ?? 2, description: head });
  }

  function play(data: AudioData) {
    try {
      if (!context) return;
      const buffer = context.createBuffer(data.numberOfChannels, data.numberOfFrames, data.sampleRate);
      for (let channel = 0; channel < data.numberOfChannels; channel++) {
        data.copyTo(buffer.getChannelData(channel), { planeIndex: channel, format: "f32-planar" });
      }
      const now = context.currentTime;
      if (playAt < now || playAt - now > MAX_LAG_S) playAt = now + LEAD_S;
      const source = context.createBufferSource();
      source.buffer = buffer; source.connect(context.destination); source.start(playAt);
      playAt += buffer.duration;
    } finally { data.close(); }
  }

  return {
    /** Every audio packet from the socket. The config packet is kept even while muted. */
    push(packet: AudioPacket) {
      if (packet.config) { head = packet.data.slice(); configure(); return; }
      if (!decoder || decoder.state !== "configured") return;
      decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: packet.pts, data: packet.data }));
    },
    /** Call from a click handler. */
    start() {
      if (context) return;
      context = new AudioContext({ latencyHint: "interactive", sampleRate: 48_000 });
      playAt = 0;
      configure();
    },
    stop() {
      if (decoder && decoder.state !== "closed") decoder.close();
      decoder = null;
      void context?.close();
      context = null;
    },
  };
}
