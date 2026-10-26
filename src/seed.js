import { createHash } from 'node:crypto';
import { validateMatch } from './validation.js';

function deterministicUuid(seed, index) {
  const bytes = createHash('sha256').update(`perrob:${seed}:${index}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function generateSeedMatches(count, seed) {
  let state = seed >>> 0;
  const random = max => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % max;
  };
  const baseEnd = Date.parse('2024-01-01T12:00:00.000Z');
  const matches = [];
  for (let i = 0; i < count; i++) {
    const aKills = random(4);
    const bKills = random(4);
    const aHits = aKills + random(6);
    const bHits = bKills + random(6);
    const aScore = random(12);
    const bScore = random(12);
    const end = new Date(baseEnd - i * 130_000);
    const start = new Date(end.getTime() - 120_000);
    matches.push(validateMatch({
      matchId: deterministicUuid(seed, i),
      roomCode: `seed-${seed}`,
      startedAt: start.toISOString(),
      endedAt: end.toISOString(),
      players: [
        { slot: 0, playerId: 'empleado-01', deliveredDocuments: aScore,
          paperBallsThrown: aHits + random(6), paperHitsLanded: aHits,
          paperHitsReceived: bHits, knockouts: aKills, deaths: bKills,
          survivalSeconds: 120 - bKills * 3 },
        { slot: 1, playerId: 'empleado-02', deliveredDocuments: bScore,
          paperBallsThrown: bHits + random(6), paperHitsLanded: bHits,
          paperHitsReceived: aHits, knockouts: bKills, deaths: aKills,
          survivalSeconds: 120 - aKills * 3 }
      ]
    }));
  }
  return matches;
}
