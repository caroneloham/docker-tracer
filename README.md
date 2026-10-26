# Docker Tracer

<img src="src/assets/autodocker-logo.png" alt="Logo AutoDocker" width="180">

**Visualiser, maintenir et faire évoluer une infrastructure Docker depuis une carte.** Docker Tracer ouvre les services, réseaux et volumes d'un projet Compose, puis propose des outils locaux pour consulter l'état réel des conteneurs, travailler sur les fichiers, diagnostiquer et préparer des changements. Il complète [AutoDocker](https://github.com/caroneloham/autodocker), qui aide à créer l'infrastructure initiale.

## Essayer ou installer

| Parcours | Ce que vous pouvez faire | Prérequis |
| --- | --- | --- |
| [Atelier navigateur sur autodocker.eu](https://autodocker.eu/essai/tracer/) | Importer un Compose, l'éditer sur la carte et exporter le résultat. Les projets vivent en mémoire dans l'onglet. | Un navigateur, sans compte. |
| [Application locale Windows ou Linux](https://github.com/caroneloham/docker-tracer/releases) | Utiliser la carte complète avec un Docker Engine local ou un hôte Linux distant par SSH : état réel, terminal, fichiers, captures et application de changements après aperçu. | Windows x64 ou Linux x64 ; Docker pour les opérations sur les conteneurs. |

L'atelier navigateur utilise l'éditeur Docker Tracer, mais **ne contacte aucun moteur Docker**. Il n'exécute ni commande, ni capture réseau, ni déploiement. L'import Compose reste dans la mémoire de l'onglet ; il n'est pas conservé après sa fermeture. Les références externes d'un Compose (`include`, `extends`, `.env`, `env_file`) ne sont pas automatiquement chargées depuis votre disque.

Pour l'application locale, téléchargez l'archive adaptée dans les [releases](https://github.com/caroneloham/docker-tracer/releases), extrayez-la entièrement, puis lancez `Docker-Tracer.cmd` sous Windows ou `./Lancer-Docker-Tracer.sh` sous Linux. Le runtime Node.js est inclus. Les instructions détaillées et le script d'arrêt sont dans le README de chaque archive. Le serveur reste sur `127.0.0.1:4310` et l'ouverture initiale active une session locale aléatoire ; ne partagez pas son URL d'accès.

![Atelier Docker Tracer](docs/assets/atelier.png)

## Développer depuis les sources

Node.js 24 est recommandé. Avec Docker Engine et Docker Compose, les fonctions locales peuvent agir sur votre environnement Docker : utilisez de préférence une machine ou un contexte de test.

```sh
npm ci
npm test
npm run build
npm start
```

`npm start` affiche dans le terminal une adresse d'accès à usage local. Ouvrez **cette adresse complète** pour activer la session protégée. Le projet et les journaux locaux sont créés dans `data/`, ignoré par Git. Le mode de développement de l'interface se lance avec `npm run dev` ; il n'est pas destiné à être exposé à d'autres machines.

Pour compiler uniquement l'atelier statique du navigateur :

```sh
npm run build:browser
```

Le résultat est dans `dist-browser/`. Le lecteur Compose plus restreint, conservé pour compatibilité, se construit avec `npm run build:viewer` dans `dist-viewer/`. Ces deux dossiers sont ignorés par Git.

Après `npm ci` et `npm run build`, les scripts de `packaging/` reproduisent les archives locales complètes à partir de ce dépôt :

```powershell
powershell -ExecutionPolicy Bypass -File packaging/build-package.ps1
```

```sh
bash packaging/build-linux-package.sh
```

Ils téléchargent le runtime officiel Node.js 24.14.0 et vérifient son SHA-256 ; les archives sont écrites dans `release/`. Le paquet Windows nécessite `npm` pour être construit, pas pour être utilisé. Le paquet Linux requiert `curl`, `tar`, `sha256sum`, `python3` et les outils usuels de compilation d'archive. Les deux paquets excluent les données locales et les fixtures de clés SSH de la dépendance `ssh2`.

## Périmètre et vérification

`npm test` couvre la logique et les API sans exiger de moteur Docker. Les tests d'intégration Docker portent le suffixe `.docker.integration.mjs` et demandent un moteur et, selon le scénario, des images ou un hôte SSH de test. La construction de l'interface et les tests unitaires ne démontrent pas à eux seuls la sûreté d'une mise en production. La redondance actuelle s'applique à certains services sur un même serveur ; elle ne remplace pas une haute disponibilité entre hôtes. Voir [VERIFICATION.md](VERIFICATION.md) pour le périmètre des contrôles et [la provenance des logos](src/assets/brands/README.md).

L'application locale dispose de fonctions puissantes d'administration Docker, de terminal et de fichiers. Ne publiez pas son port ni son API sur Internet. Vérifiez l'aperçu Compose et les sauvegardes avant d'appliquer des changements à une infrastructure réelle.

## Licence

Le code propre à Docker Tracer est publié sous la [licence AutoDocker et Docker Tracer 1.0](LICENSE) : usage professionnel, modification et vente des infrastructures produites autorisés ; vente du logiciel ou d'un accès payant à ses fonctions interdite. Il s'agit d'une licence **source accessible**, et non d'une licence open source approuvée par l'OSI. Les composants et logos tiers conservent leurs propres conditions ; leurs attributions figurent dans [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt) et dans le dossier des marques.
