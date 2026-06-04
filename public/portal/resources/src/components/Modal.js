export function openModal(content) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div class="modal-backdrop" role="presentation" data-close-modal></div>
    <section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      ${content}
    </section>
  `;
  root.querySelector('[data-close-modal]')?.addEventListener('click', closeModal);
  root.querySelector('[data-autofocus]')?.focus();
}

export function closeModal() {
  document.getElementById('modal-root').innerHTML = '';
}
