import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  BaseEdge,
  getStraightPath,
  ConnectionMode,
} from '@xyflow/react';
import { Download, FileUp, Network, Box, X } from 'lucide-react';
import EquipmentIcon from './EquipmentIcon.jsx';
import { readComposeImportFile, summarizeComposeImport } from '../shared/compose-import.mjs';
import { composeGraph } from '../shared/compose-project.mjs';
import '@xyflow/react/dist/style.css';
import './classic.css';
import './compose.css';
import './viewer.css';

const example = `name: boutique
services:
  web:
    image: nginx:alpine
    ports: ["8080:80"]
    depends_on: [api]
    networks: [front]
  api:
    image: node:22-alpine
    depends_on: [db]
    networks: [front, back]
  db:
    image: postgres:16
    networks: [back]
networks:
  front: {}
  back:
    internal: true
`;

function Device({ data, selected }) {
  return (
    <div className={'device compose-device ' + (selected ? 'selected' : '')}>
      <Handle id="left" type="source" position={Position.Left} />
      <Handle id="right" type="source" position={Position.Right} />
      <Handle id="top" type="source" position={Position.Top} />
      <Handle id="bottom" type="source" position={Position.Bottom} />
      <div className="device-picture">
        <EquipmentIcon kind={data.icon} image={data.kind === 'service' ? data.description : undefined} />
        <span className="device-led" />
      </div>
      <strong style={data.color ? { color: data.color } : undefined}>
        {data.displayName || data.name}
      </strong>
      <small title={data.description}>{data.description}</small>
      {data.subnet && <small>{data.subnet}</small>}
      {data.kind === 'service' && <span className="idle">Déclaré</span>}
    </div>
  );
}

function Cable(props) {
  const [path] = getStraightPath(props);
  return (
    <BaseEdge
      path={path}
      style={{ stroke: props.selected ? '#1772b4' : props.data?.color || '#303538', strokeWidth: 1.5 }}
    />
  );
}

const nodeTypes = { composeDevice: Device };
const edgeTypes = { composeCable: Cable };

function openCompose(source, filename) {
  const summary = summarizeComposeImport(source, filename);
  if (!summary.services.length) throw Error('Aucun service dans ce fichier. Les fichiers « include » ne sont pas lus par cette vue locale.');
  if (summary.services.length > 100) throw Error('Cette visualisation accepte au maximum 100 services.');
  return { graph: composeGraph(source), summary, filename };
}

function App() {
  const [imported, setImported] = useState(() => openCompose(example, 'Exemple · boutique'));
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);
  const [revision, setRevision] = useState(0);
  const selectedName = selected?.startsWith('service:') ? selected.slice(8) : null;
  const selectedNetwork = selected?.startsWith('network:') ? selected.slice(8) : null;
  const service = selectedName && imported.graph.model.services?.[selectedName];
  const network = selectedNetwork && imported.graph.model.networks?.[selectedNetwork];

  async function load(file) {
    if (!file || reading) return;
    setReading(true);
    setError('');
    try {
      const { filename, source } = await readComposeImportFile(file);
      setImported(openCompose(source, filename));
      setRevision((value) => value + 1);
      setSelected(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Lecture du fichier impossible.');
    } finally {
      setReading(false);
    }
  }

  return (
    <div className="viewer compose-workspace">
      <header className="compose-header viewer-header">
        <div><strong>Docker Tracer</strong><span>Visualiser un Compose</span></div>
        <a href="/essai/">AutoDocker</a>
      </header>
      <div className="viewer-intro">
        <div>
          <h1>Visualisez votre fichier Compose</h1>
          <p>Cette page affiche les services et les réseaux déclarés dans votre fichier, directement dans le navigateur. Pour travailler avec vos conteneurs, lancez l’application Docker Tracer en local.</p>
        </div>
        <div className="viewer-download">
          <a href="/essai/downloads/Docker-Tracer-0.12.2-Windows-x64.zip" download><Download size={18} aria-hidden="true" /> Télécharger Docker Tracer</a>
          <small>Application complète · Windows x64</small>
        </div>
      </div>
      <div
        className={'viewer-drop' + (dragging ? ' dragging' : '')}
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (event.dataTransfer.files.length !== 1) { setError('Déposez un seul fichier Compose.'); return; }
          load(event.dataTransfer.files[0]);
        }}
      >
        <FileUp size={24} aria-hidden="true" />
        <div><strong>Glissez docker-compose.yml ici</strong><small>ou choisissez un fichier .yaml / .yml · 2 Mio maximum</small></div>
        <label className="viewer-file">Choisir un fichier<input type="file" accept=".yaml,.yml" disabled={reading} onChange={(event) => { load(event.target.files?.[0]); event.target.value = ''; }} /></label>
      </div>
      {error && <p className="viewer-error" role="alert">{error}</p>}
      <main className="viewer-main" aria-label="Carte Compose">
        <div className="viewer-toolbar"><div><strong>{imported.filename}</strong><span>{imported.summary.services.length} services · {imported.graph.nodes.filter((node) => node.data.kind === 'network').length} réseaux déclarés ou utilisés</span></div><button type="button" onClick={() => { setImported(openCompose(example, 'Exemple · boutique')); setRevision((value) => value + 1); setSelected(null); setError(''); }}><X size={15} /> Revenir à l’exemple</button></div>
        <div className="viewer-layout">
          <section className="viewer-canvas compose-canvas" aria-label="Services et réseaux déclarés">
            <ReactFlow
              key={revision}
              nodes={imported.graph.nodes}
              edges={imported.graph.edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              connectionMode={ConnectionMode.Loose}
              fitView
              minZoom={0.12}
              maxZoom={2}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable
              onNodeClick={(_, node) => setSelected(node.id)}
              onPaneClick={() => setSelected(null)}
            >
              <Background color="#dce4e9" gap={22} />
              <Controls showInteractive={false} />
              <MiniMap pannable zoomable />
            </ReactFlow>
          </section>
          <aside className="viewer-inspector compose-inspector">
            {service ? <>
              <Box size={22} aria-hidden="true" /><h2>{selectedName}</h2>
              <dl><dt>Image</dt><dd>{service.image || (service.build ? 'Image à construire' : 'Non précisée')}</dd><dt>Ports</dt><dd>{service.ports?.length ? service.ports.map((port) => typeof port === 'object' ? `${port.published || 'auto'} → ${port.target}` : String(port)).join(', ') : 'Aucun port déclaré'}</dd><dt>Dépend de</dt><dd>{Array.isArray(service.depends_on) ? service.depends_on.join(', ') : Object.keys(service.depends_on || {}).join(', ') || 'Aucune dépendance déclarée'}</dd><dt>Mode réseau</dt><dd>{service.network_mode || 'Réseaux Compose'}</dd></dl>
            </> : selectedNetwork ? <><Network size={22} aria-hidden="true" /><h2>{selectedNetwork}</h2><p>{network?.internal ? 'Réseau interne' : network?.external ? 'Réseau externe déclaré' : 'Réseau déclaré dans Compose'}</p></> : <><Network size={24} aria-hidden="true" /><h2>Explorez la carte</h2><p>Cliquez sur un service ou un réseau pour voir sa déclaration. Les liens représentent l’appartenance aux réseaux Compose.</p></>}
            <p className="viewer-note">Cette carte lit le fichier déclaré. Elle ne vérifie pas l’état réel des conteneurs, les fichiers inclus ni les connexions réseau.</p>
            {imported.summary.warnings.length > 0 && <details><summary>Points à vérifier ({imported.summary.warnings.length})</summary><ul>{imported.summary.warnings.slice(0, 12).map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
          </aside>
        </div>
      </main>
      <footer className="viewer-footer">Aucun fichier n’est envoyé ni conservé sur le serveur. Fermer cet onglet efface cette vue.</footer>
    </div>
  );
}

for (const type of ['dragover', 'drop']) document.addEventListener(type, (event) => event.preventDefault());
createRoot(document.getElementById('root')).render(<App />);
