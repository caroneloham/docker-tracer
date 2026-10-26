import React from 'react';
import { createRoot } from 'react-dom/client';
import Inventory from '../../src/Inventory.jsx';
import '@xyflow/react/dist/style.css';
import '../../src/classic.css';

createRoot(document.getElementById('root')).render(
  <>
    <Inventory onClose={() => {}} onProjects={() => {}} />
    <div
      role="note"
      style={{
        position: 'fixed',
        bottom: 3,
        left: 6,
        zIndex: 150,
        pointerEvents: 'none',
        background: '#fff5d6',
        color: '#704615',
        padding: '4px 8px',
        font: '10px system-ui',
      }}
    >
      TEST DOCKER RÉEL ISOLÉ · 2 conteneurs jetables · HTTP réel pendant chaque capture · 30 s / 20
      Mio · aucun téléchargement
    </div>
  </>,
);
