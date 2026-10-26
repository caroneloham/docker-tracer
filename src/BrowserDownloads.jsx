import React from 'react';
import { LOCAL_APP_URL, LOCAL_LINUX_APP_URL } from './browser-mode.js';

export default function BrowserDownloads({ label = 'Télécharger Docker Tracer' }) {
  return (
    <details className="browser-downloads">
      <summary>{label}</summary>
      <div className="browser-download-menu">
        <a href={LOCAL_APP_URL} download>Windows · x64</a>
        <a href={LOCAL_LINUX_APP_URL} download>Linux · x64</a>
        <a href="/essai/tracer/assets/license.txt" target="_blank" rel="noopener noreferrer">Licence d’utilisation</a>
      </div>
    </details>
  );
}
