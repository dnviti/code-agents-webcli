// Notifications: toast-style messages and audio cues
//
// The stack is rendered by `Toasts`; this module still owns when a toast
// appears and how long it lives, which is what every caller depends on.

import { shellStore, type ToastVariant } from '../shell/store';

export type NotificationVariant = ToastVariant;

/** Monotonic so React keys stay stable even for two identical messages. */
let nextId = 1;

export function showNotification(
  message: string,
  variant: NotificationVariant = 'info',
): void {
  const id = nextId++;
  const { toasts } = shellStore.getSnapshot();
  // Four rejected images in a single paste produce four toasts; the stack
  // renders them in order rather than on top of each other.
  shellStore.setState({ toasts: [...toasts, { id, message, variant }] });

  // Errors carry a path or a limit the user may want to read twice.
  const visibleFor = variant === 'error' ? 6000 : 3000;
  setTimeout(() => {
    shellStore.setState({
      toasts: shellStore.getSnapshot().toasts.filter((toast) => toast.id !== id),
    });
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
