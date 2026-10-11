import { describe, expect, it } from 'vitest';
import { actorsOf, causedBy, laneOf } from '../src/server/launchpad/lanes.js';

describe('lanes', () => {
  it('puts a Linear issue and the comments on it in one lane', () => {
    const issue = { type: 'Issue', action: 'update', data: { id: 'i-1', identifier: 'SER-12' } };
    const comment = {
      type: 'Comment',
      action: 'create',
      data: { id: 'c-1', issueId: 'i-1', issue: { id: 'i-1', identifier: 'SER-12' } },
    };
    expect(laneOf('linear', issue)).toEqual({ key: 'linear:issue:i-1', label: 'SER-12' });
    expect(laneOf('linear', comment)).toEqual({ key: 'linear:issue:i-1', label: 'SER-12' });
    expect(laneOf('linear', { type: 'Project', data: { id: 'p-1' } })).toBeNull();
  });

  it('puts a GitHub issue or pull request and its comments and reviews in one lane', () => {
    const repository = { full_name: 'octo/app' };
    const lane = { key: 'github:octo/app#12', label: 'octo/app#12' };
    expect(
      laneOf('github', { action: 'opened', repository, pull_request: { number: 12 } }),
    ).toEqual(lane);
    const comment = { action: 'created', repository, issue: { number: 12, pull_request: {} } };
    expect(laneOf('github', comment)).toEqual(lane);
    expect(laneOf('github', { repository, discussion: { number: 3 } })?.key).toBe(
      'github:octo/app/discussions/3',
    );
    expect(laneOf('github', { action: 'opened', issue: { number: 12 } })).toBeNull();
    expect(laneOf('github', { ref: 'refs/heads/main', repository })).toBeNull();
  });

  it('puts a monday.com item and its updates in one lane', () => {
    const event = { boardId: 7, pulseId: 42, pulseName: 'Fix login' };
    expect(laneOf('monday', { event })).toEqual({ key: 'monday:7:42', label: 'Fix login' });
    expect(laneOf('monday', { event: { boardId: 7 } })).toBeNull();
  });

  it('has no lanes for generic webhooks or non-object payloads', () => {
    expect(laneOf('generic', { id: 1 })).toBeNull();
    expect(laneOf('linear', 'text')).toBeNull();
  });
});

describe('actors', () => {
  it('reads who caused the event', () => {
    expect(
      actorsOf('linear', { actor: { id: 'u-1', email: 'a@x.io' }, data: { userId: 'u-1' } }),
    ).toEqual(['u-1', 'a@x.io', 'u-1']);
    expect(actorsOf('github', { sender: { id: 5, login: 'octocat' } })).toEqual(['5', 'octocat']);
    expect(actorsOf('monday', { event: { userId: 9 } })).toEqual(['9']);
    expect(actorsOf('generic', { user: 'x' })).toEqual([]);
  });

  it("recognizes the agent's own account by user id or login", () => {
    const identity = { login: 'Bot@x.io', userId: 'u-9', name: 'Bot' };
    expect(causedBy(['u-9'], identity)).toBe(true);
    expect(causedBy(['bot@x.io'], identity)).toBe(true);
    expect(causedBy(['Bot'], identity)).toBe(false);
    expect(causedBy([], identity)).toBe(false);
    expect(causedBy(['unknown'], { login: '', userId: '' })).toBe(false);
  });
});
