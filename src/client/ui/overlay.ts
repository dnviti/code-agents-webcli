// Overlay management: loading spinner, start prompt, error display

const OVERLAY_CONTENT_IDS = ['loadingSpinner', 'startPrompt', 'errorMessage'] as const;

export function showOverlay(contentId: string): void {
  const overlay = document.getElementById('overlay');
  if (!overlay) return;

  OVERLAY_CONTENT_IDS.forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.style.display = id === contentId ? 'block' : 'none';
    }
  });

  overlay.style.display = 'flex';
}

export function hideOverlay(): void {
  const overlay = document.getElementById('overlay');
  if (overlay) {
    overlay.style.display = 'none';
  }
}

export function showError(message: string): void {
  const errorText = document.getElementById('errorText');
  if (errorText) {
    errorText.textContent = message;
  }
  showOverlay('errorMessage');
}
