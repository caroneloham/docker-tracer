# Docker Tracer 0.12.1 — paquet Linux x64

1. Extrayez **toute** l'archive `Docker-Tracer-0.12.1-Linux-x64.tar.gz` dans un dossier où vous pouvez écrire.
2. Ouvrez un terminal dans ce dossier et lancez `./Lancer-Docker-Tracer.sh`. Le navigateur s'ouvre sur l'application locale ; sinon, ouvrez l'adresse imprimée par le lanceur.
3. Pour arrêter le serveur, lancez `./Fermer-Docker-Tracer.sh`.

Node.js est inclus. Aucun compte ni installation npm n'est nécessaire. Linux x64 avec glibc 2.28 ou version ultérieure est requis. Docker Engine, Docker CLI et Docker Compose sont nécessaires aux opérations sur les conteneurs locaux. L'utilisateur doit avoir accès au socket Docker. Pour les hôtes distants, Docker Tracer utilise SSH ; Docker CLI, Docker Compose, `timeout` et l'accès au socket Docker doivent être disponibles sur l'hôte distant.

L'interface et ses API écoutent uniquement `127.0.0.1:4310`. Le lanceur crée une session locale aléatoire à chaque démarrage ; gardez privée l'adresse d'ouverture. Les projets, journaux et configurations sont stockés dans `data/` à côté du lanceur. Gardez ce dossier privé et sauvegardez-le avant de déplacer ou supprimer l'application. Le lanceur crée ce dossier avec des permissions privées selon votre `umask`.

La licence du logiciel est dans [LICENSE](LICENSE) : usage professionnel et modification autorisés, vente du logiciel ou de son accès payant interdite. Cette licence de code source accessible n'est pas une licence open source approuvée par l'OSI. Les attributions et licences des composants tiers sont dans [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).
