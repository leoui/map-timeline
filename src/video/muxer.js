/**
 * muxer.js
 *
 * Wraps mp4-muxer to produce a valid MP4 from encoded WebCodecs chunks,
 * then triggers a browser download.
 *
 * STATUS: STUB — implement following the spec below.
 *
 * ── What this module must do ──────────────────────────────────────────────────
 *
 * 1. Import mp4-muxer:
 *      import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
 *
 * 2. Create a muxer instance:
 *      const target = new ArrayBufferTarget();
 *      const muxer = new Muxer({
 *        target,
 *        video: {
 *          codec: result.codec,    // 'avc' or 'vp9' — from encoder.js
 *          width: settings.width,
 *          height: settings.height,
 *        },
 *        fastStart: 'in-memory',   // puts moov atom at front for streaming
 *      });
 *
 * 3. Feed every chunk from encoder.js:
 *      result.chunks.forEach((chunk, i) => {
 *        muxer.addVideoChunk(chunk, result.metadatas[i]);
 *      });
 *
 *    NOTE: chunks must be fed in DTS order (they already are from encoder.js).
 *
 * 4. Finalise:
 *      muxer.finalize();
 *      const buffer = target.buffer;   // ArrayBuffer
 *
 * 5. Trigger download:
 *      downloadBuffer(buffer, filename);
 *
 *    where filename = sanitiseFilename(settings.title) + '.mp4'
 *
 * ── mp4-muxer version note ────────────────────────────────────────────────────
 *  This project uses mp4-muxer ^5.x. The API changed between v4 and v5:
 *  - v5: Muxer({ target, video: { codec, width, height } })
 *  - v4: Muxer({ target, video: { codec, width, height, frameRate } })
 *  Rely on the installed version in package.json; do not hardcode v4 API.
 *
 * ── References ────────────────────────────────────────────────────────────────
 *  mp4-muxer GitHub: https://github.com/Vanilagy/mp4-muxer
 *  npm page:         https://www.npmjs.com/package/mp4-muxer
 */

import { Muxer, ArrayBufferTarget } from 'mp4-muxer';

/**
 * Mux the encoded chunks into an MP4 and download it.
 *
 * @param {import('./encoder.js').EncoderResult} result
 * @param {import('../types.js').VideoSettings} settings
 * @returns {Promise<ArrayBuffer>}  - The MP4 bytes (also triggers download)
 */
export async function muxAndDownload(result, settings) {
  if (!result || !Array.isArray(result.chunks) || result.chunks.length === 0) {
    throw new Error('No encoded video chunks to mux.');
  }

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: {
      codec: result.codec, // 'avc' or 'vp9' — from encoder.js
      width: settings.width,
      height: settings.height,
    },
    fastStart: 'in-memory', // moov atom at the front for progressive playback
  });

  // Chunks are already in DTS order from encoder.js.
  result.chunks.forEach((chunk, i) => {
    muxer.addVideoChunk(chunk, result.metadatas[i]);
  });

  muxer.finalize();
  const buffer = target.buffer; // ArrayBuffer

  downloadBuffer(buffer, sanitiseFilename(settings.title) + '.mp4');
  return buffer;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Trigger a browser file download from an ArrayBuffer.
 *
 * @param {ArrayBuffer} buffer
 * @param {string} filename
 */
export function downloadBuffer(buffer, filename) {
  const blob = new Blob([buffer], { type: 'video/mp4' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  // Revoke after a short delay so the browser has time to start the download
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 5_000);
}

/**
 * Make a string safe for use as a filename.
 * @param {string} name
 * @returns {string}
 */
export function sanitiseFilename(name) {
  return name
    .trim()
    .replace(/[^\w\s\-().]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 80) || 'journey';
}

/**
 * Estimate the final MP4 size in bytes, for display before encoding.
 * @param {import('../types.js').VideoSettings} settings
 * @param {number} bitratesBps
 * @returns {number}
 */
export function estimateSizeBytes(settings, bitratesBps) {
  return Math.round((bitratesBps * settings.durationSec) / 8);
}
