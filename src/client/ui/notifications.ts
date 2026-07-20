// Notifications: toast-style messages and audio cues

export type NotificationVariant = 'info' | 'error';

const CONTAINER_ID = 'notificationContainer';

/**
 * Toasts stack inside one container rather than each pinning itself to the
 * same fixed coordinates. Four rejected images in a single paste would
 * otherwise render four toasts exactly on top of each other.
 */
function getContainer(): HTMLElement {
  const existing = document.getElementById(CONTAINER_ID);
  if (existing) {
    return existing;
  }

  const container = document.createElement('div');
  container.id = CONTAINER_ID;
  container.className = 'notification-container';
  document.body.appendChild(container);
  return container;
}

export function showNotification(
  message: string,
  variant: NotificationVariant = 'info',
): void {
  const notification = document.createElement('div');
  notification.className = `notification notification--${variant}`;
  // An error is announced immediately because the user has to act on it; a
  // confirmation waits for a pause so it never cuts a screen reader off
  // mid-sentence.
  notification.setAttribute('role', variant === 'error' ? 'alert' : 'status');
  notification.setAttribute('aria-live', variant === 'error' ? 'assertive' : 'polite');
  notification.textContent = message;

  getContainer().appendChild(notification);

  // Errors carry a path or a limit the user may want to read twice.
  const visibleFor = variant === 'error' ? 6000 : 3000;
  setTimeout(() => {
    notification.classList.add('notification--leaving');
    setTimeout(() => notification.remove(), 300);
  }, visibleFor);
}

export function playNotificationSound(): void {
  try {
    const audio = new Audio(
      'data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmwhBRld0Oy9diMFl2+z2e7NeSgFxYvg+8SEIwW3we6eVg0FqOTupjMBSanLvV0OBba37J5QCgU4cLvfvn0cBUCd1Oq2yFSvvayILgm359+2pw8HVqfu3LNDCEij59+NLwBarvfZN20aBVGU4OyrdR0Ff5/i5paFFDGD0+ylVBYF3NTaz38nBThl4fDbmU0NF1PD5uyqUBcIJJDO5buGNggMoNvyx08FB1er/OykQRIKrau3mHs0BQ5azvfZx30VBbDe3LVmFAVK0PC1vnoPC42S4ObNozsJB1Ox58+TYyAKL5zN9r19JAWFz9P6s4s6C2uz+L2VJwUUncflwpdMC0HD5d5sFAVWv+PYiEQIDXq16eyxlSAK57vi75NkBqOZ88WzlnAHl9TmsS8JBaLj4rQ8BigO1/rPuIMtBjGI1PG+kCcFxoTg+bxnMwfSfOL55LVeCn/R+Mltbw8FBpP48KBwKgtDqPDfnzsLCJDZ/dpTWRUHo+S6+M9+lQdRp/DdnysJFXG559GdWwgTgN7z04k2Be/B8d2AUAILJLTy2Y8xBZmduvneOxYFy6H24LhpGgWunuznm0sTDbXm9bldBQuK6u7LfxUIPLH74Z5CBRt37uWmTRgB7ez+0ogeCi+J0Oe4X',
    );
    audio.volume = 0.3;
    audio.play().catch(() => {
      // Ignore autoplay restrictions
    });
  } catch {
    // Ignore sound errors
  }
}
