import { installBrowserTransport } from '../shared/browser-transport.mjs';

installBrowserTransport();
await import('./main.jsx');
