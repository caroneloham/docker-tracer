import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Database,
  Globe,
  Layers,
  Box,
  Activity,
  Plus,
  FileCode,
  Search,
  Eye,
  EyeOff,
  RefreshCw,
  Play,
  HardDrive,
} from 'lucide-react';
import {
  catalog,
  buildCatalogProject,
  generateCatalogPassword,
  newCatalogProjectName,
  suggestCatalogPort,
  catalogErrorMessage,
} from '../shared/catalog.mjs';
import { composeDocument } from '../shared/compose-project.mjs';
import './catalog.css';

const icons = { web: Globe, database: Database, cache: Layers, monitor: Activity, docker: Box };
export function CatalogIcon({ item }) {
  const Icon = icons[item.icon];
  return (
    <span className={'catalog-icon ' + item.icon} style={{ '--app-color': item.color }}>
      {Icon ? <Icon size={42} strokeWidth={1.6} /> : <span className="catalog-wordpress">W</span>}
    </span>
  );
}
async function api(path, body, revision, method = 'POST') {
  const r = await fetch(
    '/api' + path,
    body === undefined
      ? {}
      : {
          method,
          headers: {
            'Content-Type': 'application/json',
            'X-Docker-Tracer': '1',
            ...(revision ? { 'If-Match': String(revision) } : {}),
          },
          body: JSON.stringify(body),
        },
  );
  const result = await r.json();
  if (!r.ok) throw Error(result.error || 'Opération impossible.');
  return result;
}
export default function ApplicationCatalog({
  hosts,
  projects,
  currentHost,
  available,
  onOpen,
  onChooseBuilder,
  onBusyChange,
}) {
  const [query, setQuery] = useState(''),
    [category, setCategory] = useState('Toutes'),
    [item, setItem] = useState(null),
    [step, setStep] = useState('choose'),
    [values, setValues] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [created, setCreated] = useState(null),
    [plan, setPlan] = useState(null),
    [progress, setProgress] = useState(''),
    [reveal, setReveal] = useState(false),
    [portMessage, setPortMessage] = useState('');
  const suffix = useRef(''),
    portEdited = useRef(false),
    working = useRef(false);
  useEffect(() => {
    if (!created) return;
    const events = new EventSource('/api/events');
    events.onmessage = (event) => {
      const e = JSON.parse(event.data);
      if (e.projectId === created.id && e.type === 'notice')
        setProgress((p) => (p + e.message + '\n').slice(-24000));
    };
    return () => events.close();
  }, [created?.id]);
  useEffect(() => {
    if (!item || !values || created) return;
    let active = true;
    setPortMessage('Vérification des ports Docker…');
    api('/hosts/' + values.hostId + '/inventory')
      .then((inventory) => {
        if (!active) return;
        const port = suggestCatalogPort(item.port, inventory.containers);
        if (!portEdited.current) setValues((v) => ({ ...v, port }));
        setPortMessage(
          port === item.port
            ? ''
            : `Le port habituel est déjà publié dans Docker. Proposition : ${port}.`,
        );
      })
      .catch(() => {
        if (active) setPortMessage('Les ports seront vérifiés au déploiement.');
      });
    return () => {
      active = false;
    };
  }, [item?.id, values?.hostId, created?.id]);
  const built = useMemo(() => {
    if (!values || !item) return null;
    try {
      return {
        project: buildCatalogProject({
          ...values,
          templateId: item.id,
          projectName: created?.composeName || newCatalogProjectName(values.name, suffix.current),
        }),
      };
    } catch (e) {
      return { error: e.issues?.map((i) => i.message).join(' ') || e.message };
    }
  }, [values, item, created]);
  const select = (next) => {
    const hostId = currentHost || hosts[0]?.id || 'local';
    let name = next.name,
      n = 2;
    while (projects.some((p) => p.hostId === hostId && p.name === name))
      name = next.name + ' ' + n++;
    suffix.current = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    portEdited.current = false;
    setValues({
      name,
      hostId,
      port: next.port,
      exposure: 'loopback',
      password: generateCatalogPassword(),
      rootPassword: generateCatalogPassword(),
      image: 'nginx:alpine',
      targetPort: next.target,
      protocol: 'http',
      volumePath: '',
    });
    setItem(next);
    setCreated(null);
    setPlan(null);
    setError('');
    setReveal(false);
    setStep('configure');
  };
  const perform = async (fn) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    onBusyChange(true);
    setError('');
    setProgress('');
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      working.current = false;
      setBusy(false);
      onBusyChange(false);
    }
  };
  const prepare = () =>
    perform(async () => {
      if (built.error) throw Error(built.error);
      let p = created;
      if (!p) {
        const r = await api('/projects', built.project);
        p = { ...r.project, composeName: built.project.compose.projectName };
        setCreated(p);
      } else {
        const current = await api('/projects/' + p.id + '/state');
        if (current.project.revision !== p.revision) {
          throw Error(
            'Le projet a changé depuis la préparation. Ouvre sa carte pour vérifier ses réglages avant de continuer.',
          );
        }
        const r = await api(
          '/projects/' + p.id + '/compose/source',
          built.project.compose,
          p.revision,
          'PUT',
        );
        p = { ...r.project, composeName: p.composeName };
        setCreated(p);
      }
      setStep('review');
      setPlan(null);
      const next = await api(
        '/projects/' + p.id + '/compose/preview',
        built.project.compose,
        p.revision,
      );
      setPlan(next);
    });
  const install = () =>
    perform(async () => {
      try {
        const r = await api(
          '/projects/' + created.id + '/compose/apply',
          { token: plan.token },
          created.revision,
        );
        onOpen(r.project);
      } catch (e) {
        setPlan(null);
        const current = await api('/projects/' + created.id + '/state').catch(() => null);
        if (
          current &&
          Object.keys(built.project.compose).every(
            (key) =>
              JSON.stringify(current.compose[key]) === JSON.stringify(built.project.compose[key]),
          )
        )
          setCreated({ ...current.project, composeName: created.composeName });
        throw e;
      }
    });
  const host = hosts.find((h) => h.id === values?.hostId),
    model = built?.project ? composeDocument(built.project.compose.source).model : null;
  return (
    <div className="application-catalog">
      <ol className="catalog-steps" aria-label="Étapes de création">
        {[
          ['choose', 'Choisir'],
          ['configure', 'Configurer'],
          ['review', 'Installer'],
        ].map(([key, title], i) => (
          <li key={key} aria-current={step === key ? 'step' : undefined}>
            <span>{i + 1}</span>
            {title}
          </li>
        ))}
      </ol>
      {error && (
        <div className="catalog-error" role="alert">
          <p>{catalogErrorMessage(error)}</p>
          {catalogErrorMessage(error) !== error && (
            <details>
              <summary>Détail de l’erreur</summary>
              <pre>{error}</pre>
            </details>
          )}
        </div>
      )}
      {step === 'choose' ? (
        <>
          <div className="catalog-intro">
            <h3>Qu’est-ce que tu veux installer ?</h3>
            <p>
              Choisis une application. Docker Tracer prépare ses services, son réseau et son
              stockage.
            </p>
          </div>
          {!available && (
            <p className="catalog-error" role="status">
              Le catalogue nécessite le nouveau serveur Docker Tracer. Ferme l’ancien serveur puis
              relance Lancer.ps1 pour activer l’installation.
            </p>
          )}
          <div className="catalog-filters">
            <label>
              <Search size={16} />
              <input
                aria-label="Rechercher une application"
                placeholder="Rechercher une application…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <select
              aria-label="Catégorie d’applications"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              {['Toutes', ...new Set(catalog.map((t) => t.category))].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </div>
          <div className="catalog-grid">
            {catalog
              .filter(
                (t) =>
                  (category === 'Toutes' || t.category === category) &&
                  (t.name + ' ' + t.description)
                    .toLocaleLowerCase('fr')
                    .includes(query.toLocaleLowerCase('fr')),
              )
              .map((t) => (
                <button
                  type="button"
                  className="catalog-card"
                  key={t.id}
                  disabled={!available || !hosts.length}
                  onClick={() => select(t)}
                >
                  <CatalogIcon item={t} />
                  <strong>{t.name}</strong>
                  <span>{t.description}</span>
                  <small>
                    {t.services} service{t.services > 1 ? 's' : ''} · {t.category}
                  </small>
                </button>
              ))}
          </div>
          <div className="catalog-alternatives">
            <button type="button" onClick={() => onChooseBuilder('empty')}>
              <Plus size={20} />
              <span>
                <strong>Partir de zéro</strong>
                <small>Construire librement sur la carte</small>
              </span>
              <ArrowRight size={16} />
            </button>
            <button type="button" disabled={!available} onClick={() => onChooseBuilder('compose')}>
              <FileCode size={20} />
              <span>
                <strong>Importer Compose</strong>
                <small>Reprendre une infrastructure existante</small>
              </span>
              <ArrowRight size={16} />
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="catalog-selected">
            <CatalogIcon item={item} />
            <div>
              <h3>{item.name}</h3>
              <p>{item.description}</p>
              <a href={item.docs} target="_blank" rel="noreferrer">
                Documentation de l’application
              </a>
            </div>
          </div>
          {step === 'configure' ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                prepare();
              }}
            >
              <fieldset disabled={busy}>
                <div className="catalog-form-grid">
                  <label>
                    Nom de l’infrastructure
                    <input
                      required
                      disabled={!!created}
                      maxLength={80}
                      value={values.name}
                      onChange={(e) => setValues({ ...values, name: e.target.value })}
                    />
                  </label>
                  <label>
                    Installer sur
                    <select
                      disabled={!!created}
                      value={values.hostId}
                      onChange={(e) => {
                        portEdited.current = false;
                        setValues({ ...values, hostId: e.target.value });
                      }}
                    >
                      {hosts.map((h) => (
                        <option key={h.id} value={h.id}>
                          {h.name}
                          {h.kind === 'ssh' ? ' · SSH' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Port d’accès
                    <input
                      required
                      type="number"
                      min="1"
                      max="65535"
                      value={values.port}
                      onChange={(e) => {
                        portEdited.current = true;
                        setValues({ ...values, port: Number(e.target.value) });
                      }}
                    />
                  </label>
                  <label>
                    Accessible depuis
                    <select
                      value={values.exposure}
                      onChange={(e) => setValues({ ...values, exposure: e.target.value })}
                    >
                      <option value="loopback">
                        {host?.kind === 'ssh' ? 'Le serveur uniquement' : 'Ce PC uniquement'}
                      </option>
                      <option value="network">Le réseau, selon le pare-feu du serveur</option>
                    </select>
                  </label>
                </div>
                {portMessage && <p className="catalog-hint">{portMessage}</p>}
                {host?.kind === 'ssh' && values.exposure === 'loopback' && (
                  <p className="catalog-hint">
                    L’application écoutera uniquement sur le serveur SSH. Choisis l’accès réseau
                    pour la joindre directement depuis ton navigateur.
                  </p>
                )}
                {item.password && (
                  <section className="catalog-credentials">
                    <h4>Accès à {item.id === 'redis' ? 'Redis' : 'la base de données'}</h4>
                    <p>
                      Un mot de passe est généré pour cette installation. Il est conservé avec le
                      projet sur ce PC.
                    </p>
                    <label>
                      Mot de passe
                      <div className="catalog-password">
                        <input
                          required
                          minLength={16}
                          maxLength={128}
                          type={reveal ? 'text' : 'password'}
                          autoComplete="new-password"
                          value={values.password}
                          onChange={(e) => setValues({ ...values, password: e.target.value })}
                        />
                        <button
                          type="button"
                          aria-label={
                            reveal ? 'Masquer le mot de passe' : 'Afficher le mot de passe'
                          }
                          onClick={() => setReveal(!reveal)}
                        >
                          {reveal ? <EyeOff size={16} /> : <Eye size={16} />}
                        </button>
                        <button
                          type="button"
                          title="Générer un nouveau mot de passe"
                          onClick={() =>
                            setValues({ ...values, password: generateCatalogPassword() })
                          }
                        >
                          <RefreshCw size={16} />
                        </button>
                      </div>
                    </label>
                    {item.id === 'wordpress' && (
                      <small>
                        Le compte administrateur WordPress sera créé dans WordPress au premier
                        accès. MariaDB utilise un mot de passe administrateur distinct généré
                        automatiquement.
                      </small>
                    )}
                  </section>
                )}
                {item.id === 'custom' && (
                  <div className="catalog-form-grid">
                    <label>
                      Image Docker
                      <input
                        required
                        value={values.image}
                        onChange={(e) => setValues({ ...values, image: e.target.value })}
                        placeholder="éditeur/image:version"
                      />
                    </label>
                    <label>
                      Port dans le conteneur
                      <input
                        required
                        type="number"
                        min="1"
                        max="65535"
                        value={values.targetPort}
                        onChange={(e) =>
                          setValues({ ...values, targetPort: Number(e.target.value) })
                        }
                      />
                    </label>
                    <label>
                      Type d’accès
                      <select
                        value={values.protocol}
                        onChange={(e) => setValues({ ...values, protocol: e.target.value })}
                      >
                        <option value="http">Application web HTTP</option>
                        <option value="tcp">Service TCP</option>
                        <option value="udp">Service UDP</option>
                      </select>
                    </label>
                    <label>
                      Dossier persistant (facultatif)
                      <input
                        value={values.volumePath}
                        onChange={(e) => setValues({ ...values, volumePath: e.target.value })}
                        placeholder="/data"
                      />
                    </label>
                  </div>
                )}
                <div className="catalog-storage">
                  <HardDrive size={19} />
                  <div>
                    <strong>{item.storage}</strong>
                    <p>
                      {item.id === 'nginx'
                        ? 'Le contenu de la page est enregistré dans la configuration du projet.'
                        : 'Les volumes créés sont propres à cette infrastructure et restent conservés quand tu la libères.'}
                    </p>
                  </div>
                </div>
                {built?.error && (
                  <p className="catalog-error" role="alert">
                    {built.error}
                  </p>
                )}
                <div className="catalog-actions">
                  <button
                    type="button"
                    onClick={() => {
                      if (created) onOpen(created);
                      else setStep('choose');
                    }}
                  >
                    <ArrowLeft size={15} />
                    {created ? 'Ouvrir le projet enregistré' : 'Choisir une autre application'}
                  </button>
                  <button type="submit" className="catalog-primary" disabled={!!built?.error}>
                    <Check size={16} />
                    Préparer l’installation
                  </button>
                </div>
              </fieldset>
            </form>
          ) : (
            <>
              <div className="catalog-review">
                <div>
                  <small>INFRASTRUCTURE</small>
                  <strong>{values.name}</strong>
                </div>
                <div>
                  <small>SERVEUR</small>
                  <strong>{host?.name}</strong>
                </div>
                <div>
                  <small>ACCÈS</small>
                  <strong>
                    Port {values.port} ·{' '}
                    {values.exposure === 'loopback' ? 'local au serveur' : 'réseau'}
                  </strong>
                </div>
              </div>
              <div className="catalog-components">
                {Object.entries(model.services).map(([name, s]) => (
                  <article key={name}>
                    <Box size={20} />
                    <div>
                      <strong>{name}</strong>
                      <small>{s.image}</small>
                    </div>
                  </article>
                ))}
              </div>
              <p>
                <strong>{Object.keys(model.networks || {}).length} réseau(x)</strong> et{' '}
                <strong>{Object.keys(model.volumes || {}).length} volume(s)</strong> seront gérés
                avec cette infrastructure.
              </p>
              <p className="catalog-next">{item.next}</p>
              {plan?.dryRunSucceeded === false && (
                <p className="catalog-error">
                  Compose a validé la configuration, mais n’a pas terminé sa simulation. Consulte
                  les détails avant de lancer l’installation réelle.
                </p>
              )}
              {plan && (
                <details>
                  <summary>Voir le détail de la préparation</summary>
                  <pre className="proxy-preview">{plan.output}</pre>
                </details>
              )}
              <p className="catalog-hint">
                Le projet est enregistré. Après installation, la carte permet de modifier ses
                services, ports, réseaux et volumes. En cas d’échec, consulte le résultat avant de
                réessayer.
              </p>
              <div className="catalog-actions">
                <button
                  disabled={busy}
                  type="button"
                  onClick={() => {
                    setStep('configure');
                    setPlan(null);
                  }}
                >
                  <ArrowLeft size={15} />
                  Modifier les réglages
                </button>
                {!plan ? (
                  <button disabled={busy} type="button" onClick={prepare}>
                    Réessayer la préparation
                  </button>
                ) : (
                  <button
                    type="button"
                    className="catalog-primary"
                    disabled={busy}
                    onClick={install}
                  >
                    <Play size={16} />
                    Installer {item.name}
                  </button>
                )}
              </div>
              {!!error && (
                <button type="button" disabled={busy} onClick={() => onOpen(created)}>
                  Ouvrir la carte et le résultat
                </button>
              )}
            </>
          )}
        </>
      )}
      {busy && (
        <div className="catalog-progress" role="status">
          <RefreshCw className="spin" size={17} />
          <strong>
            {step === 'review' && plan
              ? 'Installation sur ' + host?.name + '…'
              : 'Préparation de l’infrastructure…'}
          </strong>
          <p>Le premier lancement peut télécharger les images nécessaires.</p>
          {progress && <pre>{progress}</pre>}
        </div>
      )}
    </div>
  );
}
