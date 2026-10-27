import React from 'react';
import { GITHUB_REPO_URL } from './browser-mode.js';

export default function BrowserDownloads({ label = 'Télécharger Docker Tracer' }) {
  return (
    <a className="browser-downloads" href={GITHUB_REPO_URL} target="_blank" rel="noopener noreferrer">{label}</a>
  );
}
