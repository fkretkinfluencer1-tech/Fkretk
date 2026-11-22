function installPasswordVisibility(input) {
  if (!(input instanceof HTMLInputElement) || input.type !== 'password' || input.dataset.passwordVisibilityReady) return;
  input.dataset.passwordVisibilityReady = 'true';

  const wrapper = document.createElement('span');
  wrapper.className = 'password-input-wrap';
  input.replaceWith(wrapper);
  wrapper.append(input);

  const button = document.createElement('button');
  button.className = 'password-visibility-toggle';
  button.type = 'button';
  button.setAttribute('aria-pressed', 'false');
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
  const updateLabel = (visible) => {
    const english = document.documentElement.lang.toLowerCase().startsWith('en');
    const label = english
      ? `${visible ? 'Hide' : 'Show'} password`
      : `${visible ? 'إخفاء' : 'إظهار'} كلمة المرور`;
    button.setAttribute('aria-label', label);
    button.title = label;
  };
  updateLabel(false);
  button.addEventListener('click', (event) => {
    event.preventDefault();
    const visible = input.type === 'password';
    input.type = visible ? 'text' : 'password';
    button.setAttribute('aria-pressed', String(visible));
    updateLabel(visible);
    input.focus();
  });
  wrapper.append(button);
}

function installPasswordVisibilityIn(root) {
  if (root instanceof HTMLInputElement) {
    installPasswordVisibility(root);
    return;
  }
  root.querySelectorAll?.('input[type="password"]').forEach(installPasswordVisibility);
}

installPasswordVisibilityIn(document);
new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node instanceof Element) installPasswordVisibilityIn(node);
    }
  }
}).observe(document.documentElement, { childList: true, subtree: true });
