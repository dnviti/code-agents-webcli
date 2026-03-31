// Notifications: toast-style messages and audio cues

export function showNotification(message: string): void {
  const notification = document.createElement('div');
  notification.className = 'notification';
  notification.textContent = message;
  notification.style.cssText = `
    position: fixed; top: 20px; right: 20px;
    background: var(--accent); color: white;
    padding: 12px 20px; border-radius: 8px;
    z-index: 10002;
    animation: slideIn 0.3s ease;
  `;

  document.body.appendChild(notification);

  setTimeout(() => {
    notification.style.animation = 'slideOut 0.3s ease';
    setTimeout(() => notification.remove(), 300);
  }, 3000);
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

/** Inject the slideIn / slideOut keyframes once. */
export function injectNotificationStyles(): void {
  if (document.getElementById('notificationKeyframes')) return;
  const style = document.createElement('style');
  style.id = 'notificationKeyframes';
  style.textContent = `
    @keyframes slideIn {
      from { transform: translateX(100%); opacity: 0; }
      to   { transform: translateX(0);    opacity: 1; }
    }
    @keyframes slideOut {
      from { transform: translateX(0);    opacity: 1; }
      to   { transform: translateX(100%); opacity: 0; }
    }
  `;
  document.head.appendChild(style);
}
