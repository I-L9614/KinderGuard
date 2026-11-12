// Server-side type gate for permit documents (the browser's accept= is only a
// hint): permits are PDFs or common images. Also used by the download route to
// decide which stored objects may render inline.
export const ALLOWED_UPLOAD_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);

// The Content-Type header is client-claimed and freely spoofable, so uploads
// are verified against the file's magic bytes before anything reaches storage.
const SIGNATURES = {
  'application/pdf': [[0x25, 0x50, 0x44, 0x46]], // %PDF
  'image/jpeg': [[0xff, 0xd8, 0xff]],
  'image/png': [[0x89, 0x50, 0x4e, 0x47]],
  'image/webp': [[0x52, 0x49, 0x46, 0x46]], // RIFF....WEBP (checked with the WEBP marker below)
};

export const matchesDeclaredType = (buffer, mimetype) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
  const signatures = SIGNATURES[mimetype];
  if (!signatures) return false;
  const headOk = signatures.some((sig) => sig.every((byte, i) => buffer[i] === byte));
  if (!headOk) return false;
  if (mimetype === 'image/webp') return buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  return true;
};
