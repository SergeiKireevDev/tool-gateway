import { describe, expect, it } from 'vitest';
import { callOutcome } from '../web/lib/activity.js';

describe('callOutcome', () => {
  it('reports calls the gateway refused as denied', () => {
    expect(callOutcome({ decision: 'denied', status: 403 })).toBe('denied');
  });

  it('reports forwarded calls with a 2xx response as succeeded', () => {
    expect(callOutcome({ decision: 'allowed', status: 200 })).toBe('succeeded');
    expect(callOutcome({ decision: 'allowed', status: 204 })).toBe('succeeded');
    expect(callOutcome({ decision: 'allowed' })).toBe('succeeded');
  });

  it('reports forwarded calls the target platform failed as failed', () => {
    expect(callOutcome({ decision: 'allowed', status: 404 })).toBe('failed');
    expect(callOutcome({ decision: 'allowed', status: 500 })).toBe('failed');
    expect(callOutcome({ decision: 'allowed', status: 502 })).toBe('failed');
    expect(callOutcome({ decision: 'allowed', status: 302 })).toBe('failed');
  });
});
