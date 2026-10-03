// Plain messages for why turning notifications on failed, instead of the browser's own error text.

/** @param {any} error what the browser threw while turning notifications on */
export function pushErrorMessage(error) {
  switch (error?.name) {
    case 'AbortError':
      return 'This browser couldn’t reach its push service. Check that push is allowed (in Brave, turn on “Use Google services for push messaging” in brave://settings/privacy) and that a VPN or blocker isn’t cutting it off, then try again.';
    case 'NotAllowedError':
      return 'This browser isn’t allowing notifications for the board. Allow them in its site settings, then try again.';
    case 'InvalidStateError':
      return 'This browser has a notification subscription from an older key. Turn notifications off in its site settings, then turn them on here again.';
    default:
      return 'Couldn’t turn notifications on. Try again.';
  }
}
