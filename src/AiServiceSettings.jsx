import React, { useEffect, useId, useState } from 'react';
import {
  ArrowLeft,
  BrainCircuit,
  Check,
  Cpu,
  ExternalLink,
  LockKeyhole,
  Settings2,
} from 'lucide-react';
import { patchAiServiceSettings } from '../shared/ai-service-context.mjs';
import { BROWSER_MODE } from './browser-mode.js';
import ComposeResources from './ComposeResources.jsx';
import EquipmentIcon from './EquipmentIcon.jsx';
import './ai-service-settings.css';

const modelKeys = new Set(['model', 'modelsPath', 'maxModelLen', 'contextLength', 'contextSize']);
const frequentKeys = new Set([
  'servedModelName',
  'gpuMemoryUtilization',
  'tensorParallelSize',
  'maxNumSeqs',
  'numParallel',
  'maxLoadedModels',
  'keepAlive',
  'gpuLayers',
  'threads',
  'parallel',
]);
const sourceLabels = {
  command: 'Commande',
  entrypoint: 'Point d’entrée',
  environment: 'Variable d’environnement',
};

function SettingField({ option, value, onChange }) {
  const id = useId();
  return (
    <div className={'ai-service-field' + (!option.editable ? ' is-readonly' : '')}>
      <label htmlFor={id}>
        <span>{option.label}</span>
        {!option.editable && (
          <small className="ai-service-readonly">
            <LockKeyhole size={12} aria-hidden="true" /> Lecture seule
          </small>
        )}
      </label>
      <input
        id={id}
        // A variable expression in a numeric setting must remain visible verbatim.
        type={option.editable && option.type === 'number' ? 'number' : 'text'}
        value={value}
        readOnly={!option.editable}
        onChange={(event) => onChange(option.key, event.target.value)}
        placeholder="Non défini dans Compose"
        min={option.min}
        max={option.max}
        step={option.integer ? 1 : option.step || 'any'}
        spellCheck={false}
        autoComplete="off"
        aria-describedby={id + '-hint'}
      />
      <small id={id + '-hint'} className="ai-service-field-hint">
        {option.reason ||
          option.hint ||
          (option.explicit
            ? sourceLabels[option.source] || 'Déclaré dans Compose'
            : 'Valeur du moteur conservée')}
      </small>
    </div>
  );
}

export default function AiServiceSettings({
  source,
  model,
  services,
  selectedService,
  hostId,
  locked,
  onChange,
  onSelectService,
  onSource,
  onBack,
}) {
  const [activeName, setActiveName] = useState(selectedService || services[0]?.name),
    [section, setSection] = useState('model'),
    [changes, setChanges] = useState({}),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const engine = services.find((item) => item.name === activeName) || services[0];
  const panelId = useId();
  useEffect(() => {
    if (services.some((item) => item.name === selectedService)) setActiveName(selectedService);
  }, [selectedService, services]);
  useEffect(() => {
    setError('');
    setMessage('');
  }, [engine?.name]);
  if (!engine) return null;

  const service = model.services?.[engine.name] || {};
  const pending = changes[engine.name] || {};
  const changed = Object.keys(pending).length > 0;
  const modelOptions = engine.options.filter((option) => modelKeys.has(option.key));
  const advancedOptions = engine.options.filter((option) => !modelKeys.has(option.key));
  const frequentOptions = advancedOptions.filter((option) => frequentKeys.has(option.key));
  const otherOptions = advancedOptions.filter((option) => !frequentKeys.has(option.key));
  const fields = (options) => (
    <div className="ai-service-fields">
      {options.map((option) => (
        <SettingField
          key={engine.name + ':' + option.key}
          option={option}
          value={
            Object.hasOwn(pending, option.key) ? pending[option.key] : String(option.value ?? '')
          }
          onChange={changeField}
        />
      ))}
    </div>
  );
  function changeField(key, value) {
    const option = engine.options.find((item) => item.key === key);
    setChanges((current) => {
      const next = { ...(current[engine.name] || {}) };
      if (value === String(option.value ?? '')) delete next[key];
      else next[key] = value;
      return { ...current, [engine.name]: next };
    });
    setError('');
    setMessage('');
  }
  function apply(event) {
    event.preventDefault();
    setError('');
    try {
      onChange(patchAiServiceSettings(source, engine.name, pending));
      setChanges((current) => ({ ...current, [engine.name]: {} }));
      setMessage(
        BROWSER_MODE
          ? 'Brouillon Compose mis à jour. Compatibilité avec votre machine non vérifiée.'
          : 'Brouillon mis à jour. Prépare le déploiement pour vérifier les changements.',
      );
    } catch (cause) {
      setError(cause.message);
    }
  }

  return (
    <div className="ai-service-settings">
      <div className="ai-service-breadcrumb">
        <button type="button" onClick={onBack}>
          <ArrowLeft size={14} aria-hidden="true" /> Carte et équipements
        </button>
        {services.length > 1 && (
          <label>
            Moteur IA
            <select
              value={engine.name}
              onChange={(event) => {
                setActiveName(event.target.value);
                onSelectService?.(event.target.value);
              }}
            >
              {services.map((item) => (
                <option key={item.name} value={item.name}>
                  {item.name} · {item.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <section className="ai-service-card" aria-label={'Réglages IA de ' + engine.name}>
        <header className="ai-service-header">
          <div className="ai-service-identity">
            <div className="ai-service-symbol">
              <EquipmentIcon image={engine.image} />
            </div>
            <div>
              <span className="ai-service-engine">{engine.label} · Déclaré dans Compose</span>
              <h2>{engine.name}</h2>
              {engine.image && <code title={engine.image}>{engine.image}</code>}
            </div>
          </div>
          <a href={engine.documentation} target="_blank" rel="noreferrer">
            Documentation <ExternalLink size={13} aria-hidden="true" />
          </a>
        </header>
        <nav className="ai-service-tabs" aria-label="Réglages du moteur IA">
          {[
            ['model', 'Modèle', BrainCircuit],
            ['hardware', 'Matériel', Cpu],
            ['advanced', 'Avancé', Settings2],
          ].map(([key, label, Icon]) => (
            <button
              key={key}
              type="button"
              aria-pressed={section === key}
              aria-controls={panelId + '-' + key}
              onClick={() => setSection(key)}
            >
              <Icon size={16} aria-hidden="true" /> {label}
            </button>
          ))}
        </nav>
        <fieldset disabled={locked} className="ai-service-content">
          <form onSubmit={apply} noValidate hidden={section === 'hardware'}>
            <section id={panelId + '-model'} hidden={section !== 'model'}>
              <div className="ai-service-section-heading">
                <h3>Modèle et contexte</h3>
                <p>{engine.note}</p>
              </div>
              {modelOptions.length > 0 ? (
                fields(modelOptions)
              ) : (
                <p className="ai-service-empty">Le modèle se configure dans {engine.label}.</p>
              )}
              <p className="ai-service-inventory">
                Les modèles installés ou chargés ne sont pas lus ici.
              </p>
            </section>
            <section id={panelId + '-advanced'} hidden={section !== 'advanced'}>
              <div className="ai-service-section-heading">
                <h3>Options du moteur</h3>
                <p>Valeurs déclarées au démarrage de {engine.label}.</p>
              </div>
              {fields(frequentOptions)}
              {otherOptions.length > 0 && (
                <details className="ai-service-advanced" key={engine.name}>
                  <summary>Autres options ({otherOptions.length})</summary>
                  {fields(otherOptions)}
                </details>
              )}
            </section>
            <div className="ai-service-form-footer">
              <small>Un champ vide retire la valeur déclarée.</small>
              {error && (
                <p className="ai-service-error" role="alert">
                  {error}
                </p>
              )}
              {message && (
                <p className="ai-service-success" role="status">
                  <Check size={16} aria-hidden="true" />
                  {message}
                </p>
              )}
              <div className="ai-service-actions">
                <button type="submit" className="ai-service-save" disabled={!changed}>
                  Ajouter au brouillon
                </button>
                {changed && (
                  <button
                    type="button"
                    onClick={() => {
                      setChanges((current) => ({ ...current, [engine.name]: {} }));
                      setError('');
                    }}
                  >
                    Annuler les saisies
                  </button>
                )}
                <button type="button" className="ai-service-source" onClick={onSource}>
                  Configuration complète
                </button>
              </div>
            </div>
          </form>
          <section id={panelId + '-hardware'} hidden={section !== 'hardware'}>
            <div className="ai-service-section-heading">
              <h3>Ressources du service</h3>
              <p>
                {BROWSER_MODE
                  ? 'CPU, RAM et GPU déclarés dans Compose. Aucune machine n’est interrogée.'
                  : 'CPU, RAM et cartes graphiques du serveur sélectionné.'}
              </p>
            </div>
            <ComposeResources
              key={engine.name}
              source={source}
              name={engine.name}
              service={service}
              hostId={hostId}
              onChange={onChange}
            />
          </section>
        </fieldset>
      </section>
    </div>
  );
}
