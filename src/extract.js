/**
 * Turning an uploaded file into text a model can read.
 *
 * A model cannot look inside a PDF or a Word file; it can read text. So uploads
 * are decoded here, at upload time, and the extracted text travels with the
 * prompt. Images are deliberately not decoded — they go to a vision model as an
 * image, which is the whole point of attaching one.
 *
 * Two container formats, no dependencies:
 *   PDF  — content streams are usually `/FlateDecode`, so inflate and read the
 *          `(...) Tj` / `[ ... ] TJ` text operators out of them.
 *   DOCX — a zip; inflate `word/document.xml` and strip the markup.
 * `DecompressionStream` is what makes this possible in a Worker: 'deflate' is
 * zlib-wrapped (PDF), 'deflate-raw' is bare (zip).
 */

/** Longest text worth carrying in a prompt; beyond this it is a liability. */
export const MAX_TEXT = 24000;

const TEXTY = ['text/', 'application/json', 'application/xml', 'application/x-yaml', 'application/javascript'];

const latin1 = (bytes) => {
  let out = '';
  const SLICE = 0x8000;
  for (let i = 0; i < bytes.length; i += SLICE) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + SLICE));
  }
  return out;
};

const bytesOf = (text) => {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
};

function indexOfBytes(hay, needle, from = 0) {
  const start = Math.max(0, from);
  outer: for (let i = start; i <= hay.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function concatChunks(chunks, total) {
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/**
 * Inflate, tolerating junk after the end of the stream.
 *
 * A PDF routinely has a newline between the compressed data and `endstream`, and
 * `DecompressionStream` calls those bytes a fatal error — while the decoded
 * output it already produced is complete and correct. So read chunk by chunk and
 * keep what arrived before the error instead of throwing the page away.
 */
async function inflate(bytes, format = 'deflate') {
  if (typeof DecompressionStream !== 'function') return null;

  let reader;
  try {
    reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format)).getReader();
  } catch {
    return null;
  }

  const chunks = [];
  let total = 0;
  while (true) {
    let step;
    try {
      step = await reader.read();
    } catch {
      break;
    }
    if (step.done) break;
    if (step.value?.length) {
      chunks.push(step.value);
      total += step.value.length;
      // A runaway stream is not worth decoding further.
      if (total > 8 * 1024 * 1024) break;
    }
  }

  return total ? concatChunks(chunks, total) : null;
}

function clip(text) {
  const value = String(text || '').replace(/\u0000/g, '').trim();
  return value.length > MAX_TEXT
    ? { text: `${value.slice(0, MAX_TEXT)}\n\n[truncated at ${MAX_TEXT} characters]`, note: 'truncated' }
    : { text: value, note: undefined };
}

/** A PDF literal string, with the escapes the spec defines. */
function decodeLiteral(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (char !== '\\') {
      out += char;
      continue;
    }
    const next = raw[(i += 1)];
    if (next === undefined) break;
    if (next === 'n') out += '\n';
    else if (next === 'r') out += '\r';
    else if (next === 't') out += '\t';
    else if (next === 'b') out += '\b';
    else if (next === 'f') out += '\f';
    else if (next === '\n' || next === '\r') {
      /* a line continuation contributes nothing */
    } else if (next >= '0' && next <= '7') {
      let octal = next;
      while (octal.length < 3 && raw[i + 1] >= '0' && raw[i + 1] <= '7') {
        octal += raw[(i += 1)];
      }
      out += String.fromCharCode(parseInt(octal, 8));
    } else out += next;
  }
  return out;
}

function decodeHex(hex) {
  const clean = hex.replace(/[^0-9a-f]/gi, '');
  let out = '';
  for (let i = 0; i + 1 < clean.length; i += 2) {
    out += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16));
  }
  return out;
}

/**
 * Text operators out of one content stream. Positions become newlines and
 * string operators become spaces, which reproduces the line breaks closely
 * enough for a model to read the page.
 */
function textFromContent(content) {
  let out = '';
  let i = 0;

  while (i < content.length) {
    const char = content[i];

    if (char === '(') {
      let depth = 1;
      let j = i + 1;
      let raw = '';
      while (j < content.length && depth > 0) {
        const at = content[j];
        if (at === '\\') {
          raw += at + (content[j + 1] ?? '');
          j += 2;
          continue;
        }
        if (at === '(') depth += 1;
        if (at === ')') {
          depth -= 1;
          if (!depth) break;
        }
        raw += at;
        j += 1;
      }
      out += decodeLiteral(raw);
      i = j + 1;
      continue;
    }

    if (char === '<' && content[i + 1] !== '<') {
      const end = content.indexOf('>', i);
      if (end < 0) break;
      out += decodeHex(content.slice(i + 1, end));
      i = end + 1;
      continue;
    }

    if (content.startsWith('Td', i) || content.startsWith('TD', i) || content.startsWith('T*', i) || content.startsWith('ET', i)) {
      out += '\n';
      i += 2;
      continue;
    }

    if (content.startsWith('Tj', i) || content.startsWith('TJ', i) || content.startsWith("'", i) || content.startsWith('"', i)) {
      out += ' ';
      i += 2;
      continue;
    }

    i += 1;
  }

  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Every text-bearing stream in the file, inflated when it says it is Flate. */
export async function pdfText(bytes) {
  const pieces = [];
  const streamMarker = bytesOf('stream');
  const endMarker = bytesOf('endstream');
  let at = 0;

  while (at < bytes.length) {
    const start = indexOfBytes(bytes, streamMarker, at);
    if (start < 0) break;

    // 'endstream' also contains 'stream' — never treat its tail as a header.
    const preceding = latin1(bytes.subarray(Math.max(0, start - 3), start));
    const dict = latin1(bytes.subarray(Math.max(0, start - 400), start));

    let dataStart = start + streamMarker.length;
    if (bytes[dataStart] === 0x0d) dataStart += 1;
    if (bytes[dataStart] === 0x0a) dataStart += 1;

    const end = indexOfBytes(bytes, endMarker, dataStart);
    if (end < 0) break;
    at = end + endMarker.length;

    if (preceding === 'end') continue;

    const raw = bytes.subarray(dataStart, end);
    if (!raw.length) continue;

    if (!/\/FlateDecode|\/Fl\b/.test(dict)) {
      const direct = textFromContent(latin1(raw));
      if (direct) pieces.push(direct);
      continue;
    }

    // The newline before `endstream` is not part of the zlib stream.
    let trimmed = raw.length;
    while (trimmed > 0 && (raw[trimmed - 1] === 0x0a || raw[trimmed - 1] === 0x0d || raw[trimmed - 1] === 0x20)) {
      trimmed -= 1;
    }
    const payload = trimmed ? raw.subarray(0, trimmed) : raw;
    const inflated = (await inflate(payload, 'deflate')) || (await inflate(payload, 'deflate-raw'));
    if (!inflated) continue;
    const text = textFromContent(latin1(inflated));
    if (text) pieces.push(text);
  }

  return pieces.join('\n\n').trim();
}

/** Local file headers of a zip, which is all a docx needs. */
export function zipEntries(bytes) {
  const entries = [];
  const signature = [0x50, 0x4b, 0x03, 0x04];
  let at = 0;

  while (at + 30 <= bytes.length) {
    const start = indexOfBytes(bytes, signature, at);
    if (start < 0) break;
    if (start + 30 > bytes.length) break;

    const view = new DataView(bytes.buffer, bytes.byteOffset + start, 30);
    const method = view.getUint16(8, true);
    const compressedSize = view.getUint32(18, true);
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    const name = latin1(bytes.subarray(start + 30, start + 30 + nameLength));
    const dataStart = start + 30 + nameLength + extraLength;

    // A zero size means the length sits after the data; without it the next
    // header cannot be found reliably, so stop rather than guess.
    if (!compressedSize || dataStart + compressedSize > bytes.length) break;

    entries.push({ name, method, data: bytes.subarray(dataStart, dataStart + compressedSize) });
    at = dataStart + compressedSize;
  }

  return entries;
}

function xmlToText(xml) {
  return xml
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function docxText(bytes) {
  const entry = zipEntries(bytes).find((item) => item.name === 'word/document.xml');
  if (!entry) return '';
  const bytesOut = entry.method === 8 ? await inflate(entry.data, 'deflate-raw') : entry.data;
  if (!bytesOut) return '';
  return xmlToText(latin1(bytesOut));
}

export const isImageType = (type) => /^image\//i.test(String(type || ''));

/**
 * The one entry point: bytes plus a declared type in, `{ kind, text }` out.
 * Never throws — an unreadable file is a file with no text, not a failed upload.
 */
export async function extractText(bytes, contentType) {
  const type = String(contentType || '')
    .toLowerCase()
    .split(';')[0]
    .trim();

  if (!bytes || !bytes.length) return { kind: 'empty', text: '' };
  if (isImageType(type)) return { kind: 'image', text: '' };

  const looksPdf = type === 'application/pdf' || latin1(bytes.subarray(0, 4)) === '%PDF';
  if (looksPdf) {
    const text = await pdfText(bytes).catch(() => '');
    const { text: clipped, note } = clip(text);
    return {
      kind: 'pdf',
      text: clipped,
      note: note || (clipped ? undefined : 'no text layer — the page is probably a scan'),
    };
  }

  const looksZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (type.includes('wordprocessingml') || (looksZip && type.includes('docx'))) {
    const text = await docxText(bytes).catch(() => '');
    const { text: clipped, note } = clip(text);
    return { kind: 'docx', text: clipped, note: note || (clipped ? undefined : 'no readable text') };
  }

  if (TEXTY.some((prefix) => type.startsWith(prefix))) {
    const { text, note } = clip(latin1(bytes));
    return { kind: 'text', text, note };
  }

  return { kind: 'binary', text: '', note: 'no text extracted from this type' };
}
