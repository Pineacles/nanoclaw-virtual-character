import { describe, expect, it } from 'vitest';

import {
  authorizeInternalCall,
  issueInternalToken,
  resolveInternalToken,
  revokeInternalToken,
} from './internal-auth.js';

describe('internal-auth', () => {
  it('issues tokens bound to a group and resolves them', () => {
    const token = issueInternalToken('testgroup');
    expect(resolveInternalToken(token)).toBe('testgroup');
    revokeInternalToken(token);
    expect(resolveInternalToken(token)).toBeNull();
  });

  it('does not resolve unknown or empty tokens', () => {
    expect(resolveInternalToken('not-a-token')).toBeNull();
    expect(resolveInternalToken(null)).toBeNull();
    expect(resolveInternalToken(undefined)).toBeNull();
    expect(resolveInternalToken('')).toBeNull();
  });

  it('issues unique tokens per spawn', () => {
    const a = issueInternalToken('testgroup');
    const b = issueInternalToken('testgroup');
    expect(a).not.toBe(b);
    revokeInternalToken(a);
    expect(resolveInternalToken(b)).toBe('testgroup');
    revokeInternalToken(b);
  });

  describe('authorizeInternalCall', () => {
    it('rejects callers without a token (including loopback/proxied traffic)', () => {
      const verdict = authorizeInternalCall({
        token: null,
        requestedGroupFolder: 'testgroup',
        instanceGroupFolder: 'testgroup',
      });
      expect(verdict.allowed).toBe(false);
    });

    it('rejects callers with a forged token', () => {
      const verdict = authorizeInternalCall({
        token: 'forged',
        requestedGroupFolder: 'testgroup',
        instanceGroupFolder: 'testgroup',
      });
      expect(verdict.allowed).toBe(false);
    });

    it('allows a container to act on its own group only', () => {
      const token = issueInternalToken('homegroup');
      const own = authorizeInternalCall({
        token,
        requestedGroupFolder: 'homegroup',
        instanceGroupFolder: 'homegroup',
      });
      expect(own.allowed).toBe(true);

      // Cross-persona scenario: homegroup's container asking for another group's data.
      const cross = authorizeInternalCall({
        token,
        requestedGroupFolder: 'otherhousehold',
        instanceGroupFolder: 'otherhousehold',
      });
      expect(cross.allowed).toBe(false);
      revokeInternalToken(token);
    });

    it('defaults the target to the instance group when none is requested', () => {
      const token = issueInternalToken('homegroup');
      const verdict = authorizeInternalCall({
        token,
        requestedGroupFolder: null,
        instanceGroupFolder: 'testgroup',
      });
      expect(verdict.allowed).toBe(false);
      revokeInternalToken(token);
    });
  });
});
