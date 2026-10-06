import { render } from 'preact';
// breakaway's type (brand/README.md): Archivo, upright and italic across its widths, and Chivo Mono.
import '@fontsource-variable/archivo/wdth.css';
import '@fontsource-variable/archivo/wdth-italic.css';
import '@fontsource-variable/chivo-mono/wght.css';
// breakaway's tokens, straight from the brand, then the base styles (buttons, fields, pills, focus) and the board's own.
import '../../brand/tokens.css';
import '../../brand/code-colors.css';
import './styles/base.css';
import './styles/app.css';
import { App } from './App.jsx';
import { checkSession, session, startPolling } from './lib/store.js';
import { startNotifications } from './lib/push.js';

render(<App />, document.getElementById('app'));
checkSession().then(() => {
  if (session.value === 'in') startNotifications();
});
startPolling();
