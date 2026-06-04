export function toast(message, tone = 'info') {
  const root = document.getElementById('toast-root');
  const item = document.createElement('div');
  item.className = `toast ${tone}`;
  item.textContent = message;
  root.appendChild(item);
  window.setTimeout(() => item.remove(), 2800);
}
