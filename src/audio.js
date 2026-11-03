/**
 * Whisper on Workers AI is happiest with clips around 1 MB. Slicing a WAV is
 * safe because every slice can carry its own 44-byte header, which is not true
 * of webm/opus or mp4/aac — the reason the client re-encodes to 16 kHz WAV
 * before uploading.
 */

export function wavInfo(bytes) {
  if (!bytes || bytes.length < 44) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riff = String.fromCharCode(...bytes.subarray(0, 4));
  const wave = String.fromCharCode(...bytes.subarray(8, 12));
  if (riff !== 'RIFF' || wave !== 'WAVE') return null;

  let offset = 12;
  let fmt = null;
  let dataOffset = -1;
  let dataLength = 0;

  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const size = dv.getUint32(offset + 4, true);
    if (id === 'fmt ' && offset + 24 <= bytes.length) {
      fmt = {
        channels: dv.getUint16(offset + 10, true),
        rate: dv.getUint32(offset + 12, true),
        bits: dv.getUint16(offset + 22, true),
      };
    } else if (id === 'data') {
      dataOffset = offset + 8;
      dataLength = Math.min(size, bytes.length - dataOffset);
      break;
    }
    offset += 8 + size + (size % 2);
  }

  if (!fmt || dataOffset < 0 || !fmt.channels || !fmt.rate || !fmt.bits) return null;
  const bytesPerSecond = fmt.rate * fmt.channels * (fmt.bits / 8);
  return {
    ...fmt,
    dataOffset,
    dataLength,
    bytesPerSecond,
    seconds: dataLength / bytesPerSecond,
  };
}

export function wrapWav(pcm, { channels = 1, rate = 16000, bits = 16 }) {
  const header = new Uint8Array(44);
  const dv = new DataView(header.buffer);
  const write = (at, text) => {
    for (let i = 0; i < text.length; i += 1) header[at + i] = text.charCodeAt(i);
  };

  write(0, 'RIFF');
  dv.setUint32(4, 36 + pcm.length, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  dv.setUint32(16, 16, true); // PCM chunk size
  dv.setUint16(20, 1, true); // format: PCM
  dv.setUint16(22, channels, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * channels * (bits / 8), true);
  dv.setUint16(32, channels * (bits / 8), true);
  dv.setUint16(34, bits, true);
  write(36, 'data');
  dv.setUint32(40, pcm.length, true);

  const out = new Uint8Array(44 + pcm.length);
  out.set(header, 0);
  out.set(pcm, 44);
  return out;
}

/** Split into sample-aligned chunks of at most `maxSeconds`, each a valid WAV. */
export function wavChunks(bytes, info, maxSeconds = 30) {
  const frameSize = info.channels * (info.bits / 8);
  const maxBytes = Math.floor((maxSeconds * info.bytesPerSecond) / frameSize) * frameSize;
  if (maxBytes <= 0 || info.dataLength <= maxBytes) return [bytes];

  const chunks = [];
  for (let pos = 0; pos < info.dataLength; pos += maxBytes) {
    const length = Math.min(maxBytes, info.dataLength - pos);
    const pcm = bytes.subarray(info.dataOffset + pos, info.dataOffset + pos + length);
    chunks.push(wrapWav(pcm, info));
  }
  return chunks;
}
