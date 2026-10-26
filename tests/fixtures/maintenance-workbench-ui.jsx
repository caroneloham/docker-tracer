import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ContainerWorkbench from '../../src/ContainerWorkbench.jsx';
import ComposeResources from '../../src/ComposeResources.jsx';
import YAML from 'yaml';

function Fixture() {
  const [target, setTarget] = useState(null),
    [open, setOpen] = useState(true),
    [gpuDemo, setGpuDemo] = useState(false),
    [gpuSource, setGpuSource] = useState(
      'services:\n  inference:\n    image: vllm/vllm-openai:latest\n    command: ["--model", "demo"]\n',
    ),
    [error, setError] = useState('');
  const refresh = async () => {
    try {
      const response = await fetch('/api/test-target');
      if (!response.ok) throw Error('Fixture indisponible.');
      setTarget(await response.json());
    } catch (error) {
      setError(error.message);
    }
  };
  useEffect(() => {
    refresh();
  }, []);
  return (
    <main style={{ fontFamily: 'system-ui', padding: 24, color: '#17374d' }}>
      <h1>Docker réel · conteneur de test isolé</h1>
      <p>
        Seul ce conteneur jetable est accessible. Aucun téléchargement, aucun volume, aucun port
        publié.
      </p>
      {error && <p>{error}</p>}
      {target && (
        <>
          <p>{target.name}</p>
          <button onClick={() => setOpen(true)}>Ouvrir la gestion réelle</button>
          <button onClick={() => setGpuDemo(!gpuDemo)}>Tester le brouillon GPU</button>
          {gpuDemo && (
            <section style={{ maxWidth: 680 }}>
              <h2>Brouillon GPU uniquement</h2>
              <p>Aucun déploiement, aucun téléchargement.</p>
              <ComposeResources
                source={gpuSource}
                name="inference"
                service={YAML.parse(gpuSource).services.inference}
                hostId="local"
                onChange={setGpuSource}
              />
              <pre aria-label="Brouillon Compose GPU">{gpuSource}</pre>
            </section>
          )}
          {open && (
            <ContainerWorkbench
              container={target}
              onClose={() => setOpen(false)}
              onChanged={refresh}
            />
          )}
        </>
      )}
    </main>
  );
}
createRoot(document.getElementById('root')).render(<Fixture />);
