const install = document.querySelector('#install-igct');
const help = document.querySelector('#install-help');
let installEvent;

if (install && help) {
  function updateInstallButton() {
    install.hidden = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  }
  updateInstallButton();
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installEvent = event;
    updateInstallButton();
  });
  window.addEventListener('appinstalled', () => {
    installEvent = null;
    install.hidden = true;
    help.hidden = true;
  });
  install.addEventListener('click', async () => {
    if (installEvent) {
      const prompt = installEvent;
      installEvent = null;
      try {
        const result = await prompt.prompt();
        if (result.outcome === 'accepted') install.hidden = true;
        return;
      } catch { /* Show the browser menu instructions below. */ }
    }
    const appleMobile = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    help.textContent = appleMobile
      ? 'In Safari, tap Share, then Add to Home Screen.'
      : 'Open your browser menu and look for Install app or Add to Home screen.';
    help.hidden = false;
  });
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(error => console.warn('IGCT install setup:', error));
}
