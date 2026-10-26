# Redonder une infrastructure existante

Document de conception, vérifié le 19 octobre 2026. Les sections LAN, VPN et données décrivent des évolutions possibles, pas des capacités déployées.

## Périmètre livré après clarification de l’utilisateur

La priorité est la résilience des conteneurs sur **une seule machine**. Le parcours « Tout sélectionner → clic droit → Redonder » prépare 2 à 4 instances des applications compatibles. Les publications existantes passent sur un proxy HAProxy commun, qui retire les instances ne répondant plus à leur contrôle HTTP ou TCP. Docker relance les processus terminés selon `unless-stopped`. La bascule fonctionne sans garder Docker Tracer ouvert.

Les services internes sans port publié conservent leurs noms DNS et leurs réseaux ; leur client doit gérer la reconnexion. Les routeurs, bases, volumes en écriture et allocations GPU non validées ne sont pas dupliqués. L’utilisateur peut les conserver en instance unique et sélectionner les applications admissibles. Chaque application nécessite une confirmation qu’elle accepte plusieurs instances. Un bridge interne distinct par service exposé préserve la séparation réseau ; le proxy rejoint ces bridges et un réseau d’entrée séparé, sans transfert IP.

Le plan est ajouté au brouillon, puis passe par l’aperçu Compose et la confirmation existants. Aucune réplication de données, aucun déplacement d’IP entre machines, aucun redémarrage forcé d’un processus simplement marqué `unhealthy`. Un arrêt manuel reste arrêté. Docker Compose ne recrée pas un conteneur supprimé comme le ferait un contrôleur Kubernetes. Le proxy, Docker, le disque et la machine restent des points de panne uniques.

Validation réelle : deux NGINX et HAProxy sur Docker Desktop, adresse identique, répartition, retrait et retour d’une instance, relance après fin du processus, puis HTTP 503 quand les deux instances sont arrêtées. Voir `output/redundancy-real-test.json`. Les ressources temporaires ont été nettoyées et les ressources préexistantes conservées. Ce test démontre une reprise locale des conteneurs, pas une protection contre la panne du serveur.

## Décision proposée

Le clic droit **Redonder** prépare un plan pour l'infrastructure sélectionnée. Le plan identifie les services, leur état persistant, les dépendances et le point d'accès des clients. Il conserve le Compose importé et explique chaque changement nécessaire. Il ne transforme pas automatiquement toute application en deux copies actives.

La V1 locale ci-dessus est implémentée. La protection future contre une panne de serveur exige au moins deux domaines de panne indépendants. Les bases existantes demandent un parcours propre à leur technologie.

La bascule doit fonctionner lorsque Docker Tracer et son navigateur sont fermés. Le contrôle de santé et le routage s'exécutent dans l'infrastructure, par exemple dans HAProxy et Keepalived. Tracer prépare, vérifie et observe leur configuration. Il ne devient pas le superviseur central dont dépend le service.

## État vérifié dans ce dépôt

| Élément | Capacité actuelle | Conséquence pour la redondance |
| --- | --- | --- |
| `server/hosts.mjs`, `shared/workspace.mjs` | Moteur local ou Linux distant par SSH. Empreinte SSH vérifiée. Le test fournit `engineId`. | Réutiliser ces identités. Deux profils pointant vers le même moteur ne constituent pas deux serveurs. |
| `data/workspace-v1.json` | Un seul profil enregistré : `local`. | Aucun second hôte n'est actuellement disponible pour prouver une bascule entre serveurs. |
| `server/project-store.mjs` | Un projet appartient à un `hostId` immuable. Nom et mode Compose immuables. | Ajouter un groupe de redondance lié à plusieurs projets. Ne pas déplacer silencieusement le projet source. |
| `server/projects.mjs` | Contrôleurs par projet, verrou par hôte, révision `If-Match`. | Une opération HA future doit acquérir tous les verrous concernés dans un ordre stable. |
| `server/compose-manager.mjs` | Aperçu Compose, jeton temporaire, signature Docker, revalidation de la configuration résolue, `up --wait`. | Étendre ce mécanisme à chaque hôte. Un aperçu ne vaut pas preuve de disponibilité. |
| `server/compose-remote.mjs` | Compose tourne sur le Linux distant. Les chemins, fichiers inclus, builds, configs et secrets se résolvent sur ce serveur. | Les fichiers locaux ne sont pas transférés implicitement vers le second hôte. |
| `shared/compose-project.mjs` | Lecture YAML et modifications ciblées qui préservent les champs étrangers. Tests des commentaires et ancres. | Réutiliser les transformations ciblées. Ne pas régénérer tout le Compose. |
| `server/volumes.mjs` | Sauvegardes des volumes de l'éditeur géré. Restauration liée au même hôte. | Ce mécanisme n'est ni une réplication, ni un transfert interhôte, ni une sauvegarde générique des projets Compose importés. |
| `shared/ai-infrastructure.mjs` | WebUI, vLLM, PostgreSQL optionnel et Caddy. Chroma local, fichiers WebUI, modèles et TLS ont des volumes distincts. | La base externe seule ne rend pas le profil IA apte à plusieurs instances. |

API existantes réutilisables : `/api/hosts`, `/api/projects`, `/api/projects/:projectId/state`, `/compose/preview`, `/compose/apply`, `/compose/source`. Les trois dernières routes sont relatives au projet. Aucun de ces contrats ne représente aujourd'hui une transaction entre plusieurs hôtes.

Les champs `previousApplied` et `lastApplied` conservent une configuration. Un retour à la configuration précédente ne restaure pas les données. Compose peut laisser un déploiement partiel après erreur ou perte SSH.

## Trois topologies distinctes

| Mode | Point d'accès | Panne couverte | Condition de validation |
| --- | --- | --- | --- |
| Un moteur local, Windows Docker Desktop ou Linux | Un port publié par un proxy vers 2 à 4 conteneurs | Arrêt d'un processus applicatif | Tester le retrait et la reprise de l’application. Le PC, le moteur, le proxy et le disque restent des points de panne. |
| Deux Linux indépendants sur un LAN compatible | VIP privée réservée, portée par un seul hôte à la fois ; HAProxy sur les deux hôtes | Panne d'un hôte ou d'un proxy, sous les prérequis du réseau et de l'application | Tester le transfert de VIP depuis un troisième client, l'arrêt d'un hôte et la perte du lien entre pairs. |
| Deux Linux sur un VPN routé ou des réseaux différents | Point d'entrée externe stable vers les deux adresses joignables | Panne d'un serveur applicatif ; le point d'entrée doit aussi avoir sa propre redondance | Vérifier la route depuis les clients et la disponibilité du point d'entrée. Aucun transfert de VIP présumé. |

Docker Desktop fait passer le réseau des conteneurs Linux par une VM et un composant de transfert de ports. Une VIP configurée dans cette VM ne démontre pas une IP flottante sur le LAN Windows. La V1 locale utilise donc un port publié ordinaire. [Docker Desktop, réseau](https://docs.docker.com/desktop/features/networking/).

Compose sur un serveur ne fournit pas à lui seul l'ordonnancement entre plusieurs serveurs. Passer à Swarm serait un changement d'orchestrateur avec son propre quorum de managers. Il n'est pas nécessaire pour la V1 et ne résout pas la réplication des données. [Docker, Compose en production](https://docs.docker.com/compose/how-tos/production/), [Docker, administration Swarm](https://docs.docker.com/engine/swarm/admin_guide/).

### Même IP pour les services web

Une seule IP d'entrée peut servir plusieurs sites. Le proxy choisit un backend par nom d'hôte HTTP ou SNI, chemin compatible, ou port distinct. Les deux instances applicatives gardent des adresses différentes. Il faut conserver les règles de routage, les certificats et les noms publics existants.

Pour une VIP LAN, réserver une adresse libre hors DHCP, préciser le préfixe et l'interface de chaque hôte, vérifier la visibilité du réseau depuis les clients et autoriser VRRP. Keepalived fournit les adresses virtuelles, les annonces multicast ou unicast et le suivi de processus ou de scripts. Suivre la santé du proxy local, pas seulement l'existence du conteneur. [Keepalived, configuration VRRP](https://www.keepalived.org/documentation/keepalived-conf/).

Le mode unicast de VRRP change le transport des annonces. Il ne crée pas une route vers une VIP sur un VPN. La V1 réserve le mode VIP aux réseaux dont la capacité de déplacement d'adresse a été démontrée. Les scénarios cloud avec API de floating IP, BGP ou routage spécial demandent un adaptateur explicite.

Un domaine DNS stable ne garantit pas une IP fixe. Deux enregistrements DNS ne retirent pas immédiatement un serveur mort des caches clients. Un proxy externe unique conserve une adresse stable, mais devient lui-même un point de panne. Le plan doit afficher ces limites et ne pas annoncer « accès redondant » dans ce cas.

La bascule peut couper les connexions TCP, WebSocket et flux de génération en cours. Les nouvelles connexions rejoignent une instance saine. Les requêtes non idempotentes ne sont pas relancées automatiquement sans mécanisme applicatif qui évite une seconde exécution.

## Santé, décision et retour au service

Quatre signaux restent distincts : moteur Docker joignable, processus vivant, application prête et rôle autorisé à écrire. Une panne SSH vue par Tracer n'est pas une preuve que le serveur est mort.

HAProxy vérifie chaque backend depuis le chemin réseau qui porte le trafic. La sonde HTTP vise une route de disponibilité connue et un statut attendu. Une sonde TCP seule démontre uniquement une connexion acceptée. Les seuils `fall`, `rise` et l'intervalle évitent un retrait ou un retour au premier incident. [HAProxy, contrôles de santé](https://www.haproxy.com/documentation/haproxy-configuration-tutorials/reliability/health-checks/).

Valeurs initiales proposées pour une fixture web : intervalle 2 s, timeout 1 s, retrait après 3 échecs, retour après 2 succès. Ce sont des réglages de test, pas un RTO garanti. Le temps de reprise mesuré inclut détection, transfert réseau, réélection éventuelle, échauffement et reconnexion client. Le plan garde `measuredRtoMs: null` avant mesure.

Une instance IA doit avoir chargé le modèle et disposer des ressources nécessaires avant de recevoir du trafic. Une base PostgreSQL joignable n'est pas nécessairement le primaire : un adaptateur Patroni vérifiera le rôle primaire et son verrou, par son API documentée, avant d'ouvrir l'accès en écriture.

Le retour automatique du serveur anciennement actif ne doit pas déclencher un changement de primaire. Pour les données, réintégrer le serveur comme réplica, vérifier sa synchronisation et décider du retour planifié. Pour l'accès réseau, préférer une politique sans préemption immédiate afin d'éviter un second déplacement inutile. Consigner chaque changement de rôle et son motif.

### Quorum et prévention de deux primaires

Une partition réseau peut laisser les deux serveurs en fonctionnement. VRRP ne remplace ni une élection de base de données, ni un verrou de stockage. Le déplacement de l'IP n'empêche pas un ancien primaire de continuer à écrire par une autre route.

Un cluster etcd décide à la majorité. Deux votants exigent les deux votes et ne tolèrent pas la perte de l'un d'eux. Trois votants indépendants permettent une majorité de deux. Trois conteneurs sur seulement deux machines ne rendent pas tous les scénarios de perte d'une machine symétriques. Le plan exige des domaines de panne explicites. [etcd, quorum et taille du cluster](https://etcd.io/docs/v3.6/faq/).

Pour une base avec bascule automatique, utiliser son protocole de réplication et un gestionnaire de rôle adapté. Une perte du verrou doit retirer le droit d'écrire avant une promotion concurrente. Le fencing isole l'ancien écrivain, par exemple par watchdog ou contrôle d'alimentation validé. Patroni peut exiger un watchdog et refuser une promotion s'il n'est pas disponible. [Patroni, protection par watchdog](https://patroni.readthedocs.io/en/latest/watchdog.html).

La V1 n'exécute aucune promotion générique sur la seule base d'un ping ou d'un timeout SSH. Sans mécanisme de rôle, quorum et fencing validé, les services à écrivain unique restent bloqués pour la bascule automatique. Une indisponibilité explicite est préférable à deux historiques de données divergents.

## Matrice des services et des données

Les catégories sont des hypothèses issues de la configuration, à confirmer. Le nom d'une image seul ne prouve pas qu'une application est sans état.

| Service ou état | Répartition possible | Traitement V1 | Blocage à lever pour une vraie HA |
| --- | --- | --- | --- |
| HTTP sans état local, sessions et fichiers déjà externes | Plusieurs instances derrière le proxy | Analyse, plan et test de backend | Vérifier toutes les dépendances, la capacité restante et la santé applicative. |
| Configuration et contenu immuables | Copie contrôlée ou image identique | Comparer empreintes et références | Les deux hôtes doivent obtenir le même contenu. Aucun transfert implicite de bind mount. |
| Sessions en mémoire | Affinité éventuelle, mais perte au redémarrage | Signaler état local | Externaliser les sessions selon l'application. L'affinité seule ne préserve pas une session après panne. |
| Fichiers utilisateurs | Stockage partagé compatible ou objet externe | Décrire la dépendance | Vérifier les écritures concurrentes, sauvegardes et disponibilité du stockage. Un NFS unique est un point de panne. |
| PostgreSQL existant | Réplication physique et primaire unique ; Patroni possible | Diagnostic et plan séparé | Initialisation contrôlée du réplica, authentification, DCS, fencing, lag, RPO et test de promotion. |
| SQLite, Chroma local, volume de base inconnu | Écrivain unique | Bloquer la duplication active du volume | Migration applicative documentée ou reprise manuelle avec arrêt complet. |
| Redis, queue, moteur vectoriel | Dépend du rôle et du produit | Classifier cache jetable ou donnée durable | Adaptateur propre au produit. Pas de duplication générique des volumes. |
| vLLM ou autre inférence sans état durable de requête | Plusieurs moteurs avec modèle identique | Vérifier GPU, VRAM, modèle, API et échauffement par hôte | Chaque survivant doit porter la charge attendue. Les requêtes actives peuvent être interrompues. |
| Cache de modèles | Copie indépendante vérifiée | Préchargement proposé | Coût disque et téléchargement ; pas de dépendance cachée au disque du premier hôte. |
| Open WebUI du profil actuel | Multi-instance après externalisation de son état | Signaler les prérequis manquants | PostgreSQL, coordination Redis, base vectorielle partagée, fichiers accessibles aux deux instances et même secret de session. |
| Caddy ou autre terminaison TLS | Instances avec politique TLS cohérente | Inventorier certificats et stockage | Éviter deux autorités internes différentes ou deux états de certificat incohérents. Stratégie de renouvellement explicite. |

Un volume Docker local reste lié à son moteur. Réutiliser le même nom de volume sur un autre moteur n'en reproduit pas le contenu. Monter les mêmes fichiers de base dans deux conteneurs en écriture ne crée pas une réplication. Le stockage partagé ne rend pas automatiquement l'application compatible avec plusieurs écrivains. [Docker, volumes et stockage entre machines](https://docs.docker.com/engine/storage/volumes/).

Le profil IA actuel utilise `VECTOR_DB=chroma` et `webui_data:/app/backend/data`. Les données SQL externes ne couvrent donc pas tout son état. La documentation Open WebUI demande une base SQL adaptée, Redis, une base vectorielle et des fichiers partagés pour plusieurs instances. Vérifier aussi la compatibilité avec l'image réellement épinglée, car la documentation courante peut décrire une autre version. [Open WebUI, mise à l'échelle](https://docs.openwebui.com/getting-started/advanced-topics/scaling/), [Open WebUI, architecture HA](https://docs.openwebui.com/enterprise/architecture/).

La réplication asynchrone peut perdre des écritures récentes après promotion. Un mode synchrone réduit ce risque au prix d'une dépendance aux réplicas pour écrire. Avec seulement deux nœuds de données, exiger deux copies durables peut bloquer les écritures lorsque l'un tombe. Même un réglage strict ne justifie pas une promesse générale de perte nulle. Le plan doit expliciter ce choix et le vérifier avec la politique réelle. [Patroni, modes de réplication](https://patroni.readthedocs.io/en/latest/replication_modes.html).

## Contrat partagé `RedundancyPlan` v1

Contrat proposé pour l'analyse, le réseau, les données et l'interface. Il n'affirme pas qu'une API est déjà implémentée. Les états sont sérialisables et les actions sont déclaratives. Aucun script libre reçu du navigateur ne doit devenir une commande privilégiée.

```ts
type Evidence = {
  state: 'verified' | 'unverified' | 'failed';
  observedAt: string | null;             // Date ISO
  method: string;                       // engine-info, config, probe, operator-attestation
  summary: string;                      // Sans secret
};

type RedundancyPlan = {
  version: 1;
  id: string;
  createdAt: string;
  expiresAt: string | null;
  source: {
    projectId: string;
    revision: number;
    sourceSha256: string;
    resolvedSha256: string | null;
    selectedServices: string[];
    dependencyServices: string[];        // Dépendances ajoutées, visibles dans l'aperçu
  };
  mode: 'single-engine-simulation' | 'multi-host-lan' | 'multi-host-routed';
  readiness: 'blocked' | 'ready';
  proof: 'planned' | 'process-tested' | 'host-tested';
  requestedCoverage: ('process' | 'host' | 'entrypoint' | 'data')[];
  effectiveCoverage: ('process' | 'host' | 'entrypoint' | 'data')[];
  hosts: {
    hostId: string;
    engineId: string | null;
    failureDomain: string | null;        // Machine / hyperviseur, pas seulement profil SSH
    roles: ('application' | 'proxy' | 'data' | 'quorum')[];
    evidence: Evidence[];
  }[];
  endpoints: {
    id: string;
    kind: 'published-port' | 'lan-vip' | 'external-entrypoint';
    address: string | null;
    publicNames: string[];
    protocol: 'http' | 'https' | 'tcp';
    port: number;
    backendServiceIds: string[];
    entrypointRedundant: boolean;
    evidence: Evidence[];
  }[];
  services: {
    id: string;
    sourceService: string;
    classification: 'stateless' | 'stateful' | 'inference' | 'unknown';
    strategy: 'active-active' | 'active-passive' | 'external' | 'blocked';
    targetHostIds: string[];
    health: {
      kind: 'http' | 'tcp' | 'role-aware' | 'unknown';
      path?: string;
      port?: number;
      intervalMs?: number;
      timeoutMs?: number;
      fall?: number;
      rise?: number;
      evidence: Evidence;
    };
    dataIds: string[];
    reasons: string[];
  }[];
  data: {
    id: string;
    serviceIds: string[];
    source: string;                     // Identifiant logique, aucun identifiant secret
    access: 'read-only' | 'single-writer' | 'multi-writer' | 'unknown';
    strategy: 'immutable-copy' | 'external' | 'native-replication' | 'manual' | 'blocked';
    adapter: string | null;             // Exemple : postgresql-patroni, jamais implicite
    maxAcceptedLossSeconds: number | null;
    measuredLagSeconds: number | null;
    quorumVerified: boolean;
    fencingVerified: boolean;
    backupVerified: boolean;
    evidence: Evidence[];
  }[];
  prerequisites: {
    code: string;
    state: 'satisfied' | 'missing' | 'unknown';
    scope: string;                      // Hôte, service, donnée ou endpoint
    message: string;
    evidence: Evidence[];
  }[];
  blockers: { code: string; scope: string; message: string; resolution: string }[];
  warnings: { code: string; scope: string; message: string }[];
  transformations: {
    id: string;
    hostId: string;
    projectId: string | null;
    kind: 'compose-patch' | 'proxy-config' | 'host-network' | 'data-adapter';
    path: string[];                     // Chemin YAML ou identifiant d'action autorisée
    reason: string;
    beforeRedacted: unknown;
    afterRedacted: unknown;
    reversible: boolean;
  }[];
  rollback: {
    configurationRecoverable: boolean;
    dataRollbackAutomatic: false;
    steps: string[];
    stopConditions: string[];
  };
  validation: {
    measuredRtoMs: number | null;
    lastResult: 'not-run' | 'passed' | 'failed' | 'inconclusive';
    checks: { id: string; scope: string; evidence: Evidence }[];
  };
};
```

Invariants à partager entre HA2, HA3 et HA4 :

1. `readiness=ready` exige zéro blocage et tous les prérequis obligatoires vérifiés. Un champ inconnu ne devient jamais vrai par défaut.
2. `proof=planned` et `effectiveCoverage=[]` tant qu'aucun exercice n'a été exécuté. Une simulation réussie donne seulement `process-tested` et la couverture `process`.
3. `host-tested` exige plusieurs domaines de panne prouvés et un exercice réel entre ces domaines. Un échec SSH simulé n'est pas un arrêt d'hôte.
4. `external` décrit un emplacement, pas une garantie HA. La disponibilité de cette dépendance reste à vérifier.
5. Un service inconnu, un volume persistant non classé ou une sonde sans sémantique connue bloque toute duplication automatique concernée.
6. Les secrets sont représentés par leurs noms de références. Masquer les valeurs dans le plan, le diff, les journaux et les exports de diagnostic.
7. Le contenu signé conservé côté serveur reste distinct de la vue expurgée envoyée à l'interface. Un plan modifié côté client n'est pas applicable.

Codes utiles : `SECOND_HOST_MISSING`, `SAME_ENGINE`, `FAILURE_DOMAIN_UNKNOWN`, `HOST_OFFLINE`, `SSH_IDENTITY_UNVERIFIED`, `ROUTING_UNVERIFIED`, `VIP_UNAVAILABLE`, `ENTRYPOINT_SINGLE_POINT`, `READINESS_UNKNOWN`, `STATE_UNCLASSIFIED`, `WRITABLE_VOLUME_UNSAFE`, `QUORUM_MISSING`, `FENCING_UNVERIFIED`, `DATA_MIGRATION_REQUIRED`, `GPU_UNVERIFIED`, `INSUFFICIENT_CAPACITY`, `SOURCE_CHANGED`.

## Parcours et transformations Compose

1. **Sélectionner** une infrastructure ou des services. Montrer les dépendances ajoutées et les éléments exclus. Une sélection de tout le graphe peut couvrir plusieurs projets ; demander un périmètre cohérent dans le panneau, sans réécrire les projets étrangers.
2. **Analyser** la configuration et l'inventaire. L'analyse est sans mutation Docker. Elle distingue les informations observées des déclarations manuelles. Les contrôles actifs sont nommés et bornés.
3. **Choisir la cible** parmi les hôtes déjà connus, ou proposer de renseigner un second hôte. Afficher le mode local comme simulation. Ne pas inventer d'adresse, d'interface, de clé SSH, de VIP ou de port libre.
4. **Préparer** le réseau et les données. Les catégories incompatibles restent bloquées. La duplication du seul frontend ne suffit pas à déclarer toute l'infrastructure redondante.
5. **Examiner** un diff ciblé par hôte et service : publications de ports, proxy, sondes, placement, stockage, fichiers requis et conséquences sur les connexions existantes.
6. **Appliquer**, lorsqu'un adaptateur supporté existe et que les prérequis passent, après revalidation. Déployer la cible sans trafic, vérifier sa santé, puis activer le routage. Conserver le service source jusqu'à la validation.
7. **Vérifier** la bascule et le retour. Afficher la portée effectivement prouvée et conserver l'historique des preuves.

Les ajouts de routes futures peuvent suivre `/api/projects/:projectId/redundancy/analyze`, `/preview`, `/apply` et `/state`. L'analyse produit un plan sans jeton d'application si l'exécution n'est pas supportée. L'aperçu applicable produit un jeton serveur éphémère lié aux révisions, empreintes de configuration, identités des moteurs et états des ressources concernées. Les chemins de fichiers et environnements doivent être revérifiés avant chaque étape. Un changement invalide le plan.

Préserver l'original, ses commentaires, ancres, extensions et champs inconnus. Conserver aussi les profils et la résolution des chemins. Un overlay peut être utile, mais Compose ne remplace pas toutes les listes de la même façon : les ports peuvent se cumuler. Toujours vérifier le modèle résolu et la compatibilité des directives avec la version Compose de chaque hôte. [Docker, fusion des fichiers Compose](https://docs.docker.com/compose/how-tos/multiple-compose-files/merge/).

Pour les services provenant de `include`, `extends`, d'un build local ou d'un bind mount, identifier la source exacte et les fichiers requis. Sans gestion explicite de ces fichiers, limiter le plan au diagnostic et bloquer la transformation. Ne pas aplatir silencieusement les services inclus.

Éviter les mutations générales : pas de changement automatique vers Swarm, pas de suppression de volume, pas de réécriture de tous les mots de passe, pas de conversion de base implicite. Le mot « Redonder » ouvre une opération de maintenance vérifiable.

### Export utilisable et export de diagnostic

Un export de configuration utilisable en V1 exige un cas entièrement supporté : service HTTP confirmé sans état local, image disponible sur les cibles, port interne connu, sonde de disponibilité explicite, dépendances déclarées et endpoint déterminé. Produire le Compose source intact, les changements ciblés par hôte, la configuration du proxy, les références de secrets attendues et un guide de validation. Identifier chaque fichier par son empreinte. Une adresse ou un chemin requis manquant bloque cet export applicable ; ne pas fournir une configuration qui semble prête avec des valeurs inventées.

Pour les autres cas, exporter le rapport et les prérequis sous le libellé **« Plan à compléter »**. Les migrations de base, le transfert de fichiers, les commandes de promotion et les configurations privilégiées de VIP n'y apparaissent pas comme des actions prêtes à exécuter. Chaque artefact indique son statut : `diagnostic`, `simulation-only` ou `deployment-candidate`. Ce dernier statut signifie configuration préparée, jamais redondance activée.

## Déploiement et rollback futurs

Enregistrer un journal durable par étape et par hôte. Les opérations interhôtes ne sont pas atomiques. Après timeout ou perte SSH, marquer l'étape `inconclusive` puis inspecter les ressources avant de réessayer. Une clé d'idempotence doit empêcher une double création. Ne pas rejouer toute la séquence à l'aveugle.

Avant activation : figer les références de configuration, identifier les données, vérifier une sauvegarde restaurable lorsque nécessaire, créer la cible et la tester sans trafic client. Le passage de trafic intervient en dernier. Les valeurs de secrets demeurent sous les mécanismes existants de leur hôte.

Si la cible échoue avant d'avoir reçu des écritures, rétablir le routage source validé puis arrêter uniquement les ajouts du plan. Si elle a reçu des écritures, une remise en service de l'ancien volume peut perdre ces changements. Bloquer le retour automatique et suivre le protocole de resynchronisation du produit.

Après promotion d'une base, l'ancien primaire reste isolé jusqu'à réinitialisation ou rattrapage contrôlé. La configuration précédente n'est pas une preuve que son disque est encore la bonne copie. Ne supprimer aucun volume pendant le rollback ; l'éventuel nettoyage suit une action distincte, ciblée par les identifiants du plan.

## Validation réaliste

### Tests purs, exécutables sans Docker

- Fixture web sans état : plan de simulation, sonde et endpoint identifiés, source étrangère préservée.
- Deux profils avec le même `engineId` : rejet de la couverture panne d'hôte.
- Source IA actuelle : détecter PostgreSQL, Chroma, fichiers WebUI et TLS. Une base externe ne lève pas les autres blocages.
- Volume en écriture inconnu, SQLite ou deux primaires sur le même volume : aucun plan applicable.
- Port fixe, `container_name`, `network_mode: host`, profils, ancres, service inclus et bind relatif : changement explicite ou blocage, jamais correction silencieuse.
- Révision ou empreinte modifiée : jeton refusé. Plan expurgé : aucune valeur de secret.

### Petite fixture sur le même moteur, à exécuter séparément

Créer deux serveurs HTTP jetables avec réponses identifiables et un proxy sur un port libre lié à `127.0.0.1`. N'utiliser aucun volume utilisateur. Vérifier la réponse, arrêter un backend, attendre son retrait, vérifier l'autre backend, redémarrer le premier et mesurer son retour. Tester aussi les deux backends indisponibles. Conserver les durées et les réponses observées.

Le protocole local a depuis été exécuté sur Docker et HAProxy ; voir `../output/redundancy-real-test.json`. Il couvre les pannes de processus et sondes décrites en tête de ce document. La panne de serveur et l'arrêt du proxy n'ont pas été provoqués. Arrêter Docker ou Windows rendrait toutes les instances locales indisponibles.

Alternative exécutable aujourd'hui sans SSH et sans téléchargement d'image : un script Node utilisant uniquement `node:http` et `node:child_process` lance deux petits serveurs HTTP et un proxy de test dans des processus enfants distincts. Les ports sont attribués par le système et liés à `127.0.0.1`. Le script ne termine que ses propres PID et retire ses fichiers temporaires dans son dossier de travail. Il mesure le retrait du backend arrêté et le maintien de la même URL locale. Il affiche **« Simulation locale de routage HTTP. Docker, HAProxy et panne d'hôte non testés. »** Cette preuve ne valide ni les configurations HAProxy exportées, ni leur déploiement futur. Elle fournit une démonstration limitée et reproductible sans toucher aux services utilisateur.

### Validation sur de vrais hôtes, après configuration

Un troisième client observe l'endpoint avant, pendant et après l'arrêt contrôlé d'un serveur. Tester séparément le backend, le proxy, l'hôte, le lien interhôte et le retour de l'ancien hôte. Pour une VIP, constater son propriétaire et sa joignabilité. Pour les données, écrire des marqueurs avant la panne, vérifier leur présence et l'unicité du primaire après promotion, puis contrôler la réintégration. En mode strict, tester le blocage attendu lorsque la durabilité demandée n'est plus possible.

Fermer Docker Tracer pendant l'exercice. La bascule doit rester fonctionnelle. Conserver les versions, domaines de panne, chronologie, pertes reconnues et RTO mesuré. Un résultat partiel reste partiel. Un plan prêt ou un test local réussi ne devient jamais une certification de l'infrastructure entière.

## Répartition des travaux

| Mission | Livrable et frontière |
| --- | --- |
| HA1, architecture | Ce contrat, les modes, les limites et les règles de preuve. Aucun changement Docker. |
| HA2, réseau | Identification des endpoints, sondes et règles de ports ; prérequis VIP/LAN/VPN ; diff du proxy ; tests ciblés. Consommer `hosts`, produire `endpoints` et les blocages réseau. |
| HA3, données | Classification de tous les mounts, états IA et dépendances ; stratégies et migrations séparées ; politiques de RPO/quorum/fencing. Produire `data` et les blocages. |
| HA4, interface | Sélection, clic droit « Redonder », panneau de plan, mode réel ou simulation, preuves et prérequis. Aucun bouton ne doit annoncer une activation que le serveur ne sait pas effectuer. |

La livraison locale prépare et déploie les instances via Compose, avec exercice réel de bascule documenté. La couverture d'une panne d'hôte reste une évolution distincte : elle demandera plusieurs hôtes accessibles, une topologie et un exercice réussi sur ces hôtes.
