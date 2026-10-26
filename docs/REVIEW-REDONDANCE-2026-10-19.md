# Revue indépendante — redondance locale et maintenance — 2026-10-19

Statut : les trois constats initiaux sont corrigés et leurs régressions vérifiées. Aucun constat P1/P2 ouvert dans le périmètre relu. Ce rapport est une revue ciblée, pas une validation globale de toutes les fonctions du produit. Aucun fichier de production n’a été modifié par le relecteur ; seul le test de régression explicitement autorisé et ce rapport ont été ajoutés.

Périmètre : `shared/redundancy-data.mjs`, `shared/redundancy-network.mjs`, `src/RedundancyDialog.jsx`, intégration dans `src/ComposeWorkspace.jsx`, connexions graphiques, détection/réglages IA, stockage IA et validation Compose.

## Constats initiaux corrigés et vérifiés

### 1. [P1] Le formulaire ne permet pas de fournir le Host requis par une sonde HTTP

- Références : `src/RedundancyDialog.jsx:86–95` et `:218–235` ; `shared/redundancy-network.mjs:546`.
- Le moteur accepte `healthHost` et valide sa syntaxe, mais le formulaire ne crée aucun champ correspondant et ne transmet que `healthPath`.
- La configuration générée envoie par défaut `Host: tracer-ha-backend-N`. Une application qui répond correctement à `/health` pour son domaine mais refuse ce Host arbitraire (contrôle d’hôte ou virtual host) est donc considérée indisponible. Toutes ses instances peuvent être écartées et l’entrée publique renvoyer une erreur après application.
- Ce n’est pas un problème de concurrence de données : le plan peut être applicable pour une application sans état et une configuration Compose valide.
- Correction concrète : ajouter un champ optionnel « Host du contrôle HTTP », le transmettre à `planLocalRedundancy`, expliquer que le chemin doit répondre 2xx pour cet hôte. Conserver le contrôle de syntaxe existant. Tester le passage du champ UI jusqu’à la ligne `http-check send`.
- Preuve : la configuration pure génère systématiquement le Host de l’alias quand la propriété manque ; aucun parcours du formulaire ne permet de la fournir. Le comportement HTTP d’une application réelle n’a pas été exercé par ce relecteur.
- Vérification après correction : le nouveau champ est saisi via les callbacks réels du composant JSX, avec le domaine `app.example:8443`, puis « Ajouter au brouillon » est déclenché. Le Compose appliqué contient bien `hdr Host app.example:8443`. Test : `release review: HTTP host entered in the dialog reaches the applied HAProxy configuration`.

### 2. [P2] Une ancre contenant un alias antérieur empêche les modifications IA et réseau

- Références : `shared/ai-service-context.mjs:425–433` ; même mécanisme dans `shared/compose-project.mjs:154–164`, utilisé par les nouvelles connexions graphiques.
- Le nœud d’un service portant une ancre est déplacé en tête du document avec `unshift`. Si ce nœud référence lui-même une ancre déclarée avant le service, l’alias se retrouve avant son ancre et la transformation échoue.
- Reproduction pure, sans Docker :

```yaml
x-common: &common
  KEEP: yes
services:
  first: &engine
    image: vllm/vllm-openai
    environment: *common
    command: [--model, org/a]
  second: *engine
```

```js
patchAiServiceSettings(source, 'first', { model: 'org/b' });
applyComposeConnection(source, {
  services: ['first'], network: 'newnet', create: true,
});
```

- Résultat observé pour les deux appels : `Unresolved alias (the anchor must be set before the alias): common`.
- Le fichier initial est valide ; une modification graphique pourtant limitée devient impossible. Les tests existants d’ancres simples ne couvrent pas cette dépendance entre ancres.
- Correction concrète : préserver le nœud original à sa position dans l’ordre du document, comme le fait déjà `editableService` de `redundancy-network.mjs`, puis modifier une copie matérialisée. Ajouter la fixture ci-dessus aux tests IA et connexions.
- Vérification après correction : les deux parcours conservent les ancres, les autres services et la valeur modifiée. Une première correction a provoqué une croissance exponentielle du YAML (222 105 octets après dix éditions) ; la correction finale ignore l’extension de sauvegarde déjà créée lors de la recherche d’ancres. Deux régressions exercent dix éditions successives et vérifient une taille bornée, la validité YAML et l’intégrité des services non modifiés.

### 3. [P2] Un moteur IA actif mais non reconnu est compté comme inactif, avec estimation complète

- Références : `server/ai-storage.mjs:294–312`, puis `:206–231`.
- `modelActive` dépend uniquement du détecteur d’images/exécutables connus. Remplacer l’image du service `inference` par un miroir privé ne désactive pourtant pas le service ni ses téléchargements de modèles.
- Reproduction pure : créer le Compose avec `buildAiCompose(defaultAiSettings(), newAiSecrets(), 'audit')`, modifier uniquement `services.inference.image` en `registry.example/vllm-mirror:1`, puis appeler `prepareAiStoragePreview`. Simuler les images toutes présentes dans `estimateAiStorageRequirements`.
- Résultat observé : `activeServices` contient `inference`, mais `modelActive: false`, `modelGiB: 0`, `modelStorage.status: 'not-required'`, `complete: true`, aucune raison d’estimation incomplète. Le message affirme que le service d’inférence n’est pas actif dans les profils choisis.
- L’inventaire d’images ne prouve pas la présence des poids : une image personnalisée déjà en cache peut télécharger un modèle au démarrage. Avec un disque détecté, le statut final peut donc devenir `ready` sur la seule réserve minimale.
- Correction concrète : distinguer « service réellement exclu par les profils » de « rôle ou moteur actif non reconnu après modification ». Pour le second cas, garder le stockage modèle inconnu et `complete: false`, sans réutiliser la taille historique. Ajouter une régression image miroir et commande devenue non reconnue.
- Vérification après correction : image miroir et commande non reconnue donnent `modelActive: true`, `modelGiB: null`, `modelStorage.status: 'unknown'`, `complete: false`. Le cas témoin réellement exclu par les profils garde `not-required` et zéro poids estimé.

## Vérifications effectuées

- 97 tests ciblés passent : `redundancy-data`, `redundancy-network`, `redundancy-ui`, `compose-connections`, `ai-service-context`, `ai-storage`, `ai-infrastructure` et les six régressions de `release-review-regressions.test.mjs`.
- Les régressions vérifient aussi le refus des équipements réseau malgré une attestation sans état : marqueur routeur, privilèges, `NET_ADMIN` / `ALL`, forwarding IPv4 / IPv6 en syntaxe objet et liste.
- Aucun pull, aucune compilation globale, aucun conteneur ni navigateur lancé par le relecteur.
- Pas de fuite nouvelle de valeurs d’environnement ou de secrets établie dans le rapport de redondance. Les diagnostics décrivent les références sans copier les valeurs.
- La construction du graphe et la détection IA sont mémorisées ; aucun défaut de performance de rendu n’est affirmé sans mesure dans le navigateur.

## Limites explicites, non classées comme bugs

- Une seule machine et un seul moteur Docker restent des points de panne. Le proxy commun reste unique.
- `unless-stopped` relance un processus arrêté ; il ne recrée pas un conteneur supprimé, ne corrige pas automatiquement `unhealthy` et respecte un arrêt manuel.
- Les communications internes restent en DNS direct. Elles ne passent pas par les sondes du proxy public ; leur reprise dépend des clients.
- Les bases, volumes en écriture et ressources GPU non validées restent bloquants même après attestation sans état. Cette restriction est cohérente avec le périmètre convenu.
- L’ajout de HAProxy peut interrompre l’accès pendant la recréation et ne conserve pas les connexions déjà ouvertes. Ces limites sont exposées.
- Le parent a trouvé et corrigé un échec réel Compose sur `configs.content` combiné à `read_only: true` du proxy généré. Le test de régression contrôle l’absence de ce réglage sur le proxy et la conservation de `cap_drop: ['ALL']`. Le démarrage réel est couvert par l’artefact ci-dessous.

## Preuve réelle fournie par le parent

Artefact lu : `output/redundancy-real-test.json`, `checkedAt: 2026-10-19T20:54:43.242Z`, `ok: true`, périmètre `local-container-failover`.

Les six scénarios consignés réussissent : deux instances sur la même adresse ; retrait d’une instance non prête ; réintégration après rétablissement ; relance après fin du processus applicatif ; retour de l’instance relancée dans le trafic ; indisponibilité explicite quand aucune instance n’est prête. Le nettoyage des conteneurs, réseaux, volumes et images est confirmé par l’artefact. Les durées observées restent des observations de cette fixture, sans garantie de délai pour d’autres applications.

Les tests Docker ont été exécutés par le parent ; le relecteur a vérifié l’artefact et les sources, sans répéter les actions Docker. Aucun essai d’interaction dans un navigateur n’a été effectué par le relecteur ; le passage du Host UI a été testé en mémoire sur les callbacks JSX réels.
