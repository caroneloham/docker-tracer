import React, { useState } from 'react';
import { Save, Plus, Trash2 } from 'lucide-react';
import DeviceSettings from './DeviceSettings.jsx';
import { newNode } from '../shared/model.mjs';
import { validateEquipmentTemplate } from '../shared/templates.mjs';

export default function EquipmentTemplates({ models, onSave, onDelete, seed }) {
  const empty = () => ({ ...newNode('custom', 'template', { x: 0, y: 0 }).data, icon: 'server' });
  const [id, setId] = useState(''),
    [title, setTitle] = useState(seed ? `${seed.label} personnalisé` : ''),
    [data, setData] = useState(seed || empty),
    [error, setError] = useState(''),
    [saved, setSaved] = useState('');
  const field = (key, value) => {
    setData((d) => ({ ...d, [key]: value }));
    setSaved('');
  };
  const choose = (next) => {
    const m = models.find((m) => m.id === next);
    setId(m?.id || '');
    setTitle(m?.title || '');
    setData(m ? structuredClone(m.data) : empty());
    setError('');
    setSaved('');
  };
  const submit = (e) => {
    e.preventDefault();
    try {
      const m = validateEquipmentTemplate({
        id: id || `custom-${crypto.randomUUID().slice(0, 8)}`,
        title,
        data,
      });
      onSave(m);
      setId(m.id);
      setData(m.data);
      setError('');
      setSaved('Modèle enregistré dans la palette.');
    } catch (e) {
      setError(e.issues?.map((i) => i.message).join(' ') || e.message);
    }
  };
  return (
    <>
      <span className="eyebrow">ÉQUIPEMENTS PERSONNALISÉS</span>
      <h2>Mes modèles Docker</h2>
      <p>
        Prépare un équipement une fois, puis retrouve-le dans la palette pour tes prochains réseaux.
      </p>
      <div className="template-library-actions">
        <select aria-label="Choisir un modèle" value={id} onChange={(e) => choose(e.target.value)}>
          <option value="">Nouveau modèle</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.title}
            </option>
          ))}
        </select>
        <button title="Nouveau modèle" onClick={() => choose('')}>
          <Plus size={14} />
        </button>
      </div>
      <form className="template-editor" onSubmit={submit}>
        <div className="template-form-row">
          <label>
            Nom du modèle
            <input
              value={title}
              maxLength={48}
              required
              onChange={(e) => {
                setTitle(e.target.value);
                setSaved('');
              }}
              placeholder="Mon serveur API"
            />
          </label>
        </div>
        <DeviceSettings data={data} onChange={field} showName={false} />
        <p className="field-hint template-help">
          Les modèles restent dans ce navigateur. Un modèle prépare la configuration ; son
          enregistrement ne lance aucun conteneur. Chaque équipement garde ensuite ses propres
          réglages.
        </p>
        {error && (
          <p className="pdu-error" role="alert">
            {error}
          </p>
        )}
        {saved && (
          <p className="probe-result-summary" role="status">
            {saved}
          </p>
        )}
        <div className="template-save-actions">
          <button
            type="button"
            disabled={!id}
            onClick={() => {
              onDelete(id);
              choose('');
            }}
          >
            <Trash2 size={13} />
            Supprimer ce modèle
          </button>
          <button type="submit" className="deploy-button">
            <Save size={14} />
            Enregistrer le modèle
          </button>
        </div>
      </form>
    </>
  );
}
