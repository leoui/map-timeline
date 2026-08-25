/**
 * encoder.js
 *
 * WebCodecs VideoEncoder pipeline.
 *
 * STATUS: STUB - the shell is here, implementation needs completing.
 *
 *
 * ── What this module must do ──────────────────────────────────────────────────
 *
 * 1. Check browser support:
 *      typeof VideoEncoder !== 'undefined'
 *    If missing, throw a descriptive error. The UI already shows a warning
 *    banner (see ui/controls.js), but the encoder should throw too.
 *
 * 2. Configure the encoder:
 *      const encoder = new VideoEncoder({ output, error })
 *      encoder.configure({
 *        codec: 'avc1.42001f',   // H.264 Baseline Level 3.1
 *        width:  settings.width,
 *        height: settings.height,
 *        bitrate: bitrateForFormat(settings),
 *        framerate: settings.fps,
 *        // Optional but recommended:
 *        avc: { format: 'annexb' },   // mp4-muxer wants 'avc' format, not annexb
 *      })
 *
 *    NOTE: mp4-muxer expects the codec string 'avc' in its Muxer config but
 *    the browser's VideoEncoder takes the full MIME codec string 'avc1.42001f'.
 *    They are different things - don't mix them up.
 *
 *    For VP9 as a fallback (when H.264 hardware encoder is unavailable):
 *      codec: 'vp09.00.10.08'
 *    and set `avc: undefined`, `mp4-muxer` codec: 'vp9'.
 *
 * 3. Frame loop - for each frame index 0..totalFrames-1:
 *      a. await compositor.drawFrame(frameIndex)
 *      b. const videoFrame = new VideoFrame(compositor.canvas, {
 *           timestamp: (frameIndex / settings.fps) * 1_000_000,  // microseconds
 *           duration:  (1 / settings.fps) * 1_000_000,
 *         })
 *      c. const keyFrame = frameIndex % keyFrameInterval === 0
 *      d. encoder.encode(videoFrame, { keyFrame })
 *      e. videoFrame.close()   ← MUST close to release GPU memory
 *      f. Call onProgress(frameIndex, totalFrames)
 *
 *    Key-frame interval: every 2 seconds → keyFrameInterval = settings.fps * 2
 *
 *    The encoder runs async internally. To avoid building up a huge queue,
 *    await a flush every N frames (e.g. every fps frames):
 *      if (frameIndex % settings.fps === 0) await encoder.flush()
 *
 * 4. After the loop: await encoder.flush()
 *
 * 5. Return the accumulated chunks array (populated by the `output` callback).
 *
 * ── Bitrate guidance ─────────────────────────────────────────────────────────
 *  Square 480p   →  2_000_000 bps
 *  Square 720p   →  4_000_000 bps
 *  Square 1080p  →  8_000_000 bps
 *  Portrait 1080 → 10_000_000 bps
 *  Landscape     → 10_000_000 bps
 *
 * ── Error handling ───────────────────────────────────────────────────────────
 *  If encoder.configure() rejects (unsupported codec on this device), catch it
 *  and try VP9 before giving up.
 *
 * ── References ───────────────────────────────────────────────────────────────
 *  WebCodecs API spec: https://www.w3.org/TR/webcodecs/
 *  Chrome implementation notes: https://developer.chrome.com/docs/web-platform/best-practices/webcodecs
 *  mp4-muxer docs: https://github.com/Vanilagy/mp4-muxer
 */

/**
 * @typedef {Object} EncoderResult
 * @property {EncodedVideoChunk[]} chunks
 * @property {EncodedVideoChunkMetadata[]} metadatas
 * @property {string} codec  - 'avc' | 'vp9' (for the muxer)
 */

/**
 * Encode all frames and return the raw chunks for the muxer.
 *
 * @param {import('./compositor.js').Compositor} compositor
 * @param {import('../types.js').AnimFrame[]} frames
 * @param {import('../types.js').VideoSettings} settings
 * @param {(framesEncoded: number, totalFrames: number) => void} onProgress
 * @returns {Promise<EncoderResult>}
 */
export async function encode(compositor, frames, settings, onProgress) {
  // ── Browser support check ────────────────────────────────────────────────
  if (typeof VideoEncoder === 'undefined') {
    throw new Error(
      'VideoEncoder is not available in this browser. ' +
      'Please use Chrome 94+ or Edge 94+. Firefox is not yet supported.'
    );
  }

  if (typeof VideoFrame === 'undefined') {
    throw new Error(
      'VideoFrame is not available in this browser. ' +
      'Please use Chrome 94+ or Edge 94+.'
    );
  }

  const totalFrames = frames.length;
  if (totalFrames === 0) {
    throw new Error('Nothing to encode: the journey produced zero animation frames.');
  }

  const chunks = [];
  const metadatas = [];
  let codecName = 'avc';

  // ── Configure encoder (H.264 first, VP9 fallback) ────────────────────────
  let encodeError = null;
  const encoder = new VideoEncoder({
    output(chunk, metadata) {
      chunks.push(chunk);
      metadatas.push(metadata ?? {});
    },
    error(e) {
      // Surface async encoder errors to the awaiting loop / flush.
      encodeError = e;
    },
  });

  const baseConfig = {
    width: settings.width,
    height: settings.height,
    bitrate: bitrateForFormat(settings),
    framerate: settings.fps,
  };

  // Prefer H.264 so the result plays in QuickTime / Safari / iOS (which do NOT
  // support VP9). We try High and Main profiles at a level high enough for the
  // resolution before Baseline - Baseline L3.1 (avc1.42001f) can't handle 1080p,
  // so requesting only it makes capable machines fall back to VP9 needlessly.
  const h264Config = await pickH264Config(baseConfig);
  if (h264Config) {
    encoder.configure(h264Config);
    codecName = 'avc';
  } else {
    const vp9Config = { ...baseConfig, codec: 'vp09.00.10.08' };
    if (!(await isSupported(vp9Config))) {
      encoder.close();
      throw new Error(
        `No supported video codec found at ${settings.width}×${settings.height} on this device.`
      );
    }
    encoder.configure(vp9Config);
    codecName = 'vp9';
  }

  // ── Frame loop ───────────────────────────────────────────────────────────
  const keyFrameInterval = settings.fps * 2; // key frame every 2 seconds
  const frameDurationUs = Math.round((1 / settings.fps) * 1_000_000);

  try {
    for (let i = 0; i < totalFrames; i++) {
      if (encodeError) throw encodeError;

      await compositor.drawFrame(i);

      const videoFrame = new VideoFrame(compositor.canvas, {
        timestamp: Math.round((i / settings.fps) * 1_000_000),
        duration: frameDurationUs,
      });

      encoder.encode(videoFrame, { keyFrame: i % keyFrameInterval === 0 });
      videoFrame.close(); // release GPU memory immediately

      // Backpressure: if the encoder queue grows, let it drain so we don't
      // buffer hundreds of frames' worth of GPU memory at once.
      if (encoder.encodeQueueSize > settings.fps) {
        await encoder.flush();
      }

      onProgress(i + 1, totalFrames);
    }

    await encoder.flush();
    if (encodeError) throw encodeError;
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }

  return { chunks, metadatas, codec: codecName };
}

/**
 * Candidate H.264 codec strings, in preference order. All are QuickTime/Safari/
 * iOS-compatible. Levels are chosen to cover up to 4K:
 *   High  L5.1 (640033) → High  L4.0 (640028)
 *   Main  L5.1 (4d0033) → Main  L4.0 (4d0028)
 *   Baseline L3.1 (42001f, small formats only) as a last resort.
 * @type {string[]}
 */
const H264_CANDIDATES = [
  'avc1.640033',
  'avc1.640028',
  'avc1.4d0033',
  'avc1.4d0028',
  'avc1.42001f',
];

/**
 * Find the first supported H.264 config for these dimensions, or null.
 * mp4-muxer wants a length-prefixed ('avc') bitstream, not annex-b.
 * @param {Omit<VideoEncoderConfig,'codec'>} baseConfig
 * @returns {Promise<VideoEncoderConfig|null>}
 */
async function pickH264Config(baseConfig) {
  for (const codec of H264_CANDIDATES) {
    const config = { ...baseConfig, codec, avc: { format: 'avc' } };
    if (await isSupported(config)) return config;
  }
  return null;
}

/**
 * Wrapper around VideoEncoder.isConfigSupported that never throws.
 * @param {VideoEncoderConfig} config
 * @returns {Promise<boolean>}
 */
async function isSupported(config) {
  try {
    const support = await VideoEncoder.isConfigSupported(config);
    return support.supported === true;
  } catch {
    return false;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Return an appropriate bitrate in bps for the given settings.
 * @param {import('../types.js').VideoSettings} settings
 * @returns {number}
 */
export function bitrateForFormat(settings) {
  const { width, height } = settings;
  const pixels = width * height;
  if (pixels <= 480 * 480)   return 2_000_000;
  if (pixels <= 720 * 720)   return 4_000_000;
  if (pixels <= 1080 * 1080) return 8_000_000;
  return 10_000_000;
}

/**
 * Check whether the browser can encode H.264 with the given dimensions.
 * Returns true if supported, false if we should fall back to VP9.
 *
 * @param {number} width
 * @param {number} height
 * @returns {Promise<boolean>}
 */
export async function supportsH264(width, height) {
  if (typeof VideoEncoder === 'undefined') return false;
  const config = await pickH264Config({
    width,
    height,
    bitrate: bitrateForFormat({ width, height }),
    framerate: 30,
  });
  return config !== null;
}
