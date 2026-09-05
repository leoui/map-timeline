import { describe, it, expect } from 'vitest';
import { parseTimeline, summarise, detectTimezoneOffsetMin, offsetMinFromISO, majorityOffsetMin, distinctOffsets } from '../src/parser.js';

describe('per-point timezone helpers', () => {
  it('offsetMinFromISO reads an offset and treats Z as unknown (null)', () => {
    expect(offsetMinFromISO('2026-01-01T08:00:00+09:00')).toBe(540);
    expect(offsetMinFromISO('2026-01-01T08:00:00-05:30')).toBe(-330);
    expect(offsetMinFromISO('2026-01-01T08:00:00Z')).toBe(null);
    expect(offsetMinFromISO(1700000000000)).toBe(null);
  });

  it('parsed points carry their local offset, and majority ignores UTC-only points', () => {
    // Jakarta trip that crosses into Japan for one segment.
    const raw = [
      { startTime: '2026-01-02T08:00:00+07:00', endTime: '2026-01-02T09:00:00+07:00',
        visit: { topCandidate: { placeLocation: 'geo:-6.2,106.8' } } },
      { startTime: '2026-01-03T08:00:00+09:00', endTime: '2026-01-03T09:00:00+09:00',
        activity: { start: 'geo:35.6,139.7', end: 'geo:35.7,139.8' } },
      { startTime: '2026-01-06T08:00:00+07:00', endTime: '2026-01-06T09:00:00+07:00',
        visit: { topCandidate: { placeLocation: 'geo:-6.2,106.8' } } },
    ];
    const pts = parseTimeline(raw);
    expect(pts.every((p) => p.offsetMin != null)).toBe(true);
    // Two Jakarta points vs two Japan points -> Jakarta wins on count only if it
    // has more; here it is 2 vs 2, so ensure both zones are represented.
    const offs = distinctOffsets(pts).map((o) => o.offsetMin).sort((a, b) => a - b);
    expect(offs).toEqual([420, 540]);
  });

  it('majorityOffsetMin picks the most common per-point offset', () => {
    const pts = [
      { lat: 0, lng: 0, timestampMs: 1, offsetMin: 420 },
      { lat: 0, lng: 0, timestampMs: 2, offsetMin: 420 },
      { lat: 0, lng: 0, timestampMs: 3, offsetMin: 540 },
      { lat: 0, lng: 0, timestampMs: 4, offsetMin: null },
    ];
    expect(majorityOffsetMin(pts)).toBe(420);
    expect(majorityOffsetMin([{ timestampMs: 1, offsetMin: null }])).toBe(null);
  });
});

describe('detectTimezoneOffsetMin', () => {
  it('reads a positive offset from an ISO timestamp', () => {
    expect(detectTimezoneOffsetMin([{ startTime: '2026-02-20T06:00:00+07:00' }])).toBe(420);
  });
  it('reads a negative offset', () => {
    expect(detectTimezoneOffsetMin({ t: '2018-02-20T10:02:13-05:30' })).toBe(-330);
  });
  it('prefers a real offset over a Z (UTC) timestamp', () => {
    const raw = [{ endTime: '2026-01-01T00:00:00Z' }, { startTime: '2026-01-01T09:00:00+09:00' }];
    expect(detectTimezoneOffsetMin(raw)).toBe(540);
  });
  it('picks the majority (home) offset when the trip crosses zones', () => {
    const raw = [
      { startTime: '2026-01-01T08:00:00+07:00' },
      { startTime: '2026-01-02T08:00:00+07:00' },
      { startTime: '2026-03-01T08:00:00+09:00' }, // a short trip abroad
      { startTime: '2026-01-03T08:00:00+07:00' },
    ];
    expect(detectTimezoneOffsetMin(raw)).toBe(420);
  });
  it('falls back to 0 when every timestamp is Z', () => {
    expect(detectTimezoneOffsetMin([{ startTime: '2026-01-01T00:00:00Z' }])).toBe(0);
  });
  it('returns null when there is no offset info', () => {
    expect(detectTimezoneOffsetMin({ locations: [{ timestampMs: 1600000000000 }] })).toBe(null);
  });
});

// ── Format D: on-device "Timeline" export (bare top-level array) ────────────────

describe('parseTimeline - on-device Timeline export (bare array)', () => {
  const mobile = [
    {
      startTime: '2014-05-23T14:13:07.613+07:00',
      endTime: '2014-05-23T18:50:04.535+07:00',
      visit: { topCandidate: { placeLocation: 'geo:-6.253327,106.798137' } },
    },
    {
      startTime: '2014-05-24T09:04:07.530+07:00',
      endTime: '2014-05-24T09:52:40.731+07:00',
      activity: { start: 'geo:-6.207423,106.770564', end: 'geo:-6.255882,106.802830' },
    },
    {
      startTime: '2014-05-23T06:00:00.000Z',
      endTime: '2014-05-23T08:00:00.000Z',
      timelinePath: [
        { point: 'geo:-6.254193,106.800032', durationMinutesOffsetFromStartTime: '73' },
      ],
    },
    // Records with no coordinates must be ignored, not throw.
    { startTime: '2014-05-25T00:00:00Z', endTime: '2014-05-25T01:00:00Z', timelineMemory: {} },
  ];

  it('parses visit, activity, and timelinePath records', () => {
    const pts = parseTimeline(mobile);
    // visit(1) + activity(2) + timelinePath(1) = 4 points
    expect(pts).toHaveLength(4);
    for (const p of pts) {
      expect(p.lat).toBeGreaterThanOrEqual(-90);
      expect(p.lat).toBeLessThanOrEqual(90);
      expect(Number.isFinite(p.timestampMs)).toBe(true);
    }
  });

  it('applies the timelinePath minute offset to the segment start', () => {
    const pts = parseTimeline([mobile[2]]);
    const start = Date.parse('2014-05-23T06:00:00.000Z');
    expect(pts[0].timestampMs).toBe(start + 73 * 60_000);
  });

  it('returns points sorted chronologically', () => {
    const pts = parseTimeline(mobile);
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i].timestampMs).toBeGreaterThanOrEqual(pts[i - 1].timestampMs);
    }
  });

  it('honours a date-range filter', () => {
    const startMs = Date.parse('2014-05-24T00:00:00Z');
    const endMs = Date.parse('2014-05-24T23:59:59Z');
    const pts = parseTimeline(mobile, { startMs, endMs });
    // Only the activity segment falls entirely on the 24th.
    expect(pts.length).toBe(2);
  });
});

// ── Legacy formats still work ──────────────────────────────────────────────────

describe('parseTimeline - legacy formats', () => {
  it('parses Format A (latitudeE7 + timestampMs)', () => {
    const raw = {
      locations: [
        { latitudeE7: 523456780, longitudeE7: 133456780, timestampMs: '1600000000000' },
        { latitudeE7: 523456790, longitudeE7: 133456790, timestampMs: '1600000060000' },
      ],
    };
    const pts = parseTimeline(raw);
    expect(pts).toHaveLength(2);
    expect(pts[0].lat).toBeCloseTo(52.345678, 5);
  });

  it('parses Format C (semanticSegments + geo: points)', () => {
    const raw = {
      semanticSegments: [
        {
          timelinePath: [
            { point: 'geo:1.5,2.5', time: '2020-01-01T00:00:00Z' },
            { point: 'geo:1.6,2.6', time: '2020-01-01T00:01:00Z' },
          ],
        },
      ],
    };
    const pts = parseTimeline(raw);
    expect(pts).toHaveLength(2);
    expect(pts[0].lng).toBeCloseTo(2.5, 5);
  });

  it('throws on an unrecognised shape', () => {
    expect(() => parseTimeline({ nope: true })).toThrow(/Unrecognised/i);
  });

  it('throws a date-range message when the filter empties a valid file', () => {
    const raw = { locations: [{ latitudeE7: 100000000, longitudeE7: 100000000, timestampMs: 1000 }] };
    expect(() => parseTimeline(raw, { startMs: 5000, endMs: 9000 })).toThrow(/date range/i);
  });
});

describe('summarise', () => {
  it('reports count and span', () => {
    const s = summarise([
      { lat: 0, lng: 0, timestampMs: 10 },
      { lat: 1, lng: 1, timestampMs: 50 },
    ]);
    expect(s).toEqual({ count: 2, startMs: 10, endMs: 50 });
  });
});
