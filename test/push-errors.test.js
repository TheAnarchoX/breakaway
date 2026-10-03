import { describe, expect, it } from 'vitest';
import { pushErrorMessage } from '../web/src/lib/push-errors.js';

describe('pushErrorMessage', () => {
  it('explains a missing push service without the browser’s text', () => {
    const message = pushErrorMessage(
      Object.assign(new Error('Registration failed - push service error'), { name: 'AbortError' }),
    );
    expect(message).toContain('VPN or blocker');
    expect(message).toContain('Brave');
    expect(message).not.toContain('Registration failed');
  });

  it('maps blocked permission and a changed key', () => {
    expect(pushErrorMessage({ name: 'NotAllowedError' })).toContain('site settings');
    expect(pushErrorMessage({ name: 'InvalidStateError' })).toContain('older key');
  });

  it('falls back to a generic message', () => {
    expect(pushErrorMessage(new Error('boom'))).toBe('Couldn’t turn notifications on. Try again.');
    expect(pushErrorMessage(undefined)).toBe('Couldn’t turn notifications on. Try again.');
  });
});
