import { describe, it, expect } from 'vitest';
import { sanitiseFilename, estimateSizeBytes } from '../src/video/muxer.js';

describe('sanitiseFilename', () => {
  it('strips unsafe characters and spaces', () => {
    expect(sanitiseFilename('My Trip: Tokyo/2024!')).toBe('My-Trip-Tokyo2024');
  });

  it('falls back to "journey" when empty', () => {
    expect(sanitiseFilename('   ')).toBe('journey');
    expect(sanitiseFilename('!!!')).toBe('journey');
  });

  it('caps length', () => {
    expect(sanitiseFilename('a'.repeat(200)).length).toBeLessThanOrEqual(80);
  });
});

describe('estimateSizeBytes', () => {
  it('computes bytes from bitrate × duration', () => {
    // 8 Mbps for 10 s = 10 MB.
    expect(estimateSizeBytes({ durationSec: 10 }, 8_000_000)).toBe(10_000_000);
  });
});
