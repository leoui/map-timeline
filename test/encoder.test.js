import { describe, it, expect, afterEach } from 'vitest';
import { bitrateForFormat, supportsH264 } from '../src/video/encoder.js';

describe('bitrateForFormat', () => {
  it('scales bitrate with resolution', () => {
    expect(bitrateForFormat({ width: 480, height: 480 })).toBe(2_000_000);
    expect(bitrateForFormat({ width: 720, height: 720 })).toBe(4_000_000);
    expect(bitrateForFormat({ width: 1080, height: 1080 })).toBe(8_000_000);
    expect(bitrateForFormat({ width: 1080, height: 1920 })).toBe(10_000_000);
  });
});

// supportsH264 exercises the codec-candidate selection: it must accept a device
// that only supports High/Main profiles (not Baseline L3.1) - the exact case
// that previously forced a QuickTime-incompatible VP9 fallback at 1080p.
describe('supportsH264 codec selection', () => {
  afterEach(() => {
    delete globalThis.VideoEncoder;
  });

  function mockVideoEncoder(supportedCodecs) {
    globalThis.VideoEncoder = {
      isConfigSupported: async (cfg) => ({
        supported: supportedCodecs.includes(cfg.codec),
        config: cfg,
      }),
    };
  }

  it('returns false when VideoEncoder is unavailable', async () => {
    delete globalThis.VideoEncoder;
    expect(await supportsH264(1080, 1920)).toBe(false);
  });

  it('accepts a device that only supports High profile (not Baseline L3.1)', async () => {
    mockVideoEncoder(['avc1.640028']); // High L4.0 only
    expect(await supportsH264(1080, 1920)).toBe(true);
  });

  it('still accepts Baseline-only devices for small formats', async () => {
    mockVideoEncoder(['avc1.42001f']); // Baseline L3.1 only
    expect(await supportsH264(480, 480)).toBe(true);
  });

  it('returns false when no H.264 profile is available', async () => {
    mockVideoEncoder(['vp09.00.10.08']); // VP9 only
    expect(await supportsH264(1080, 1920)).toBe(false);
  });
});
