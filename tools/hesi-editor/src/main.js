import { createEditorApp } from './editor-app.js';

const root = document.getElementById('app');

try {
  const app = await createEditorApp(root);
  window.hesiEditor = app;
} catch (error) {
  console.error('[hesi-editor] startup failed', error);
  root.innerHTML = '';
  const message = document.createElement('pre');
  message.style.cssText = 'margin:24px;color:#ff8088;white-space:pre-wrap';
  message.textContent = `HESI editor failed to start\n\n${error?.stack || error}`;
  root.append(message);
}
