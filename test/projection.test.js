import { describe, it, expect } from 'vitest';
import {
  latLngToTile,
  tileToLatLng,
  fitZoom,
  centroid,
  haversineMetres,
} from '../src/map/projection.js';

describe('projection', () => {
  it('latLngToTile ↔ tileToLatLng round-trips', () => {
    const z = 12;
    const { x, y } = latLngToTile(48.8566, 2.3522, z); // Paris
    const { lat, lng } = tileToLatLng(x, y, z);
    expect(lat).toBeCloseTo(48.8566, 4);
    expect(lng).toBeCloseTo(2.3522, 4);
  });

  it('centroid averages the points', () => {
    const c = centroid([
      { lat: 0, lng: 0 },
      { lat: 10, lng: 20 },
    ]);
    expect(c.lat).toBeCloseTo(5, 6);
    expect(c.lng).toBeCloseTo(10, 6);
  });

  it('haversineMetres matches a known distance (Paris→London ≈ 344 km)', () => {
    const d = haversineMetres(48.8566, 2.3522, 51.5074, -0.1278);
    expect(d / 1000).toBeGreaterThan(330);
    expect(d / 1000).toBeLessThan(360);
  });

  it('fitZoom picks a lower zoom for a wider spread', () => {
    const tight = [
      { lat: 48.85, lng: 2.35 },
      { lat: 48.86, lng: 2.36 },
    ];
    const wide = [
      { lat: 48.85, lng: 2.35 },
      { lat: 40.0, lng: -3.0 },
    ];
    expect(fitZoom(tight, 512, 512, 32)).toBeGreaterThan(fitZoom(wide, 512, 512, 32));
  });
});
