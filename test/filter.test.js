import { describe, it, expect } from 'vitest';
import { filterOutliers, totalDistanceMetres } from '../src/journey/filter.js';

describe('filterOutliers', () => {
  it('returns input unchanged when mode is off', () => {
    const pts = [
      { lat: 0, lng: 0, timestampMs: 0 },
      { lat: 89, lng: 0, timestampMs: 1000 }, // impossible jump, but off = keep
      { lat: 0, lng: 0, timestampMs: 2000 },
    ];
    expect(filterOutliers(pts, 'off')).toBe(pts);
  });

  it('drops a single spike that snaps back', () => {
    // Two nearby points with a far spike between them, 1 second apart.
    const pts = [
      { lat: 0.0, lng: 0.0, timestampMs: 0 },
      { lat: 40.0, lng: 40.0, timestampMs: 1000 }, // teleport spike
      { lat: 0.001, lng: 0.001, timestampMs: 2000 },
    ];
    const out = filterOutliers(pts, 'conservative');
    expect(out).toHaveLength(2);
    expect(out).not.toContainEqual(pts[1]);
  });

  it('keeps short lists untouched', () => {
    const pts = [{ lat: 1, lng: 1, timestampMs: 0 }, { lat: 2, lng: 2, timestampMs: 10 }];
    expect(filterOutliers(pts, 'conservative')).toBe(pts);
  });
});

describe('totalDistanceMetres', () => {
  it('sums consecutive leg distances', () => {
    const d = totalDistanceMetres([
      { lat: 0, lng: 0 },
      { lat: 0, lng: 1 },
      { lat: 0, lng: 2 },
    ]);
    // Two ~111 km legs at the equator.
    expect(d / 1000).toBeGreaterThan(200);
    expect(d / 1000).toBeLessThan(250);
  });

  it('is zero for a single point', () => {
    expect(totalDistanceMetres([{ lat: 5, lng: 5 }])).toBe(0);
  });
});
