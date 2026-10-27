# Développer et vérifier Docker Tracer

[Retour au README](../README.md)


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

`npm test` couvre la logique et les API sans exiger de moteur Docker. Les tests d'intégration Docker portent le suffixe `.docker.integration.mjs` et demandent un moteur et, selon le scénario, des images ou un hôte SSH de test. La construction de l'interface et les tests unitaires ne démontrent pas à eux seuls la sûreté d'une mise en production. La redondance actuelle s'applique à certains services sur un même serveur ; elle ne remplace pas une haute disponibilité entre hôtes. Voir [VERIFICATION.md](../VERIFICATION.md) pour le périmètre des contrôles et [la provenance des logos](../src/assets/brands/README.md).

L'application locale dispose de fonctions puissantes d'administration Docker, de terminal et de fichiers. Ne publiez pas son port ni son API sur Internet. Vérifiez l'aperçu Compose et les sauvegardes avant d'appliquer des changements à une infrastructure réelle.
