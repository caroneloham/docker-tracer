# Docker Tracer 0.12.1 — paquet Windows x64

1. Extrayez **toute** l'archive ZIP dans un dossier où vous pouvez écrire, par exemple `Documents\Docker Tracer`.
2. Démarrez Docker Desktop en mode conteneurs Linux.
3. Double-cliquez sur **Docker-Tracer.cmd**. Le navigateur s'ouvre sur l'application locale.
4. Pour arrêter le serveur, double-cliquez sur **Fermer-Docker-Tracer.cmd**.

Node.js est inclus. Aucun compte ni installation npm n'est nécessaire. Docker CLI et Docker Compose doivent être installés pour appliquer des changements Compose au moteur local. Pour les hôtes Linux distants, Docker Tracer utilise SSH ; Docker CLI, Docker Compose, `timeout` et l'accès au socket Docker doivent être disponibles sur l'hôte distant.

L'interface et ses API écoutent uniquement `127.0.0.1:4310`. Le lanceur crée une session locale aléatoire à chaque démarrage ; gardez privée l'adresse d'ouverture. Les projets, journaux et configurations sont stockés dans `data/` à côté du lanceur. Gardez ce dossier privé et sauvegardez-le avant de déplacer ou supprimer l'application.

La licence du logiciel est dans [LICENSE](LICENSE) : usage professionnel et modification autorisés, vente du logiciel ou de son accès payant interdite. Cette licence de code source accessible n'est pas une licence open source approuvée par l'OSI. Les attributions et licences de tiers sont dans [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).
