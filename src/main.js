import { createStandaloneApplication } from './standalone/application.js';
import { describeError } from './standalone/errors.js';
import { bindLanguageControls, initializeLocale, t } from './i18n.js';
import { initializeAutoTranslation } from './autoTranslate.js';

initializeLocale();
window.addEventListener('DOMContentLoaded', () => {
  bindLanguageControls(document);
  initializeAutoTranslation(document);
});

const application = createStandaloneApplication({
  googleApiKey: import.meta.env.GOOGLE_MAPS_API_KEY,
  cesiumToken: import.meta.env.CESIUM_ION_TOKEN,
  allowQaRegistration: import.meta.env.DEV,
});

application.start().catch((error) => {
  console.error("God's Eye View initialization failed:", error);
  const loaderStatus = document.querySelector('#loading-screen .loader-status');
  loaderStatus.textContent = `${t('errorPrefix')}${describeError(error)}`;
  loaderStatus.style.color = '#ff4444';
});

export { application };
