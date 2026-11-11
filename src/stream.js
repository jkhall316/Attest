// Streaming base64 JSON body for OpenRouter's `input_audio` form, so a large recording
// goes R2 -> base64 -> fetch without ever being held in Worker memory (128MB limit).
// Multipart uploads are capped at 25MB by OpenRouter; this path is for anything bigger.

const enc = new TextEncoder();
const STEP = 30000; // multiple of 3, so each slice encodes without padding

function b64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += STEP) out += btoa(String.fromCharCode.apply(null, bytes.subarray(i, i + STEP)));
  return out;
}

// Uint8Array chunks in, base64 text bytes out. Carries up to 2 bytes between chunks so
// padding appears only once, at the end.
export function base64Transform() {
  let carry = new Uint8Array(0);
  return new TransformStream({
    transform(chunk, ctl) {
      const all = new Uint8Array(carry.length + chunk.length);
      all.set(carry); all.set(chunk, carry.length);
      const n = all.length - (all.length % 3);
      if (n) ctl.enqueue(enc.encode(b64(all.subarray(0, n))));
      carry = all.slice(n);
    },
    flush(ctl) { if (carry.length) ctl.enqueue(enc.encode(b64(carry))); },
  });
}

export const base64Length = (n) => 4 * Math.ceil(n / 3);

// {head}{base64 of audio}{tail} as one body. `pull` keeps back-pressure so nothing buffers.
export function jsonAudioBody(audio, head, tail) {
  const reader = audio.pipeThrough(base64Transform()).getReader();
  let stage = 0;
  return new ReadableStream({
    async pull(ctl) {
      if (stage === 0) { ctl.enqueue(enc.encode(head)); stage = 1; return; }
      const { done, value } = await reader.read();
      if (done) { ctl.enqueue(enc.encode(tail)); ctl.close(); } else ctl.enqueue(value);
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}

// Wraps a body so fetch sends a Content-Length instead of chunked encoding, when the
// runtime has FixedLengthStream (Workers do). `length` must be exact.
export function withLength(body, length) {
  if (typeof FixedLengthStream !== 'function') return body;
  const fls = new FixedLengthStream(length);
  body.pipeTo(fls.writable).catch(() => {});
  return fls.readable;
}
