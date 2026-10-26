# Vérification de Docker Tracer 0.12.1

Contrôles répétés le 26 octobre 2026 sur cette copie destinée à GitHub, après installation propre avec `npm ci --ignore-scripts --no-audit --no-fund` :

| Commande | Résultat |
| --- | --- |
| `npm test` | 312 tests réussis, aucun échec. |
| `npm run build` | Interface locale compilée dans `dist/`. |
| `npm run build:browser` | Atelier navigateur compilé dans `dist-browser/`. |
| `npm run build:viewer` | Lecteur Compose autonome compilé dans `dist-viewer/`. |

La suite `npm test` n'exécute pas les scénarios `*.docker.integration.mjs`. Ces scénarios demandent Docker, des images ou un hôte SSH adaptés ; leur réussite dépend de l'environnement. Les builds prouvent que les sources compilent, pas que des actions sur une infrastructure réelle sont sûres. Vérifiez chaque aperçu Compose et la sauvegarde des données avant application.

L'atelier navigateur manipule une déclaration Compose en mémoire. Il n'exécute pas Docker et ne montre pas l'état réel, les journaux ou le trafic d'un hôte. L'application locale complète écoute uniquement `127.0.0.1` et protège ses API par une session locale lors d'un démarrage en production. Elle ne doit pas être exposée directement sur Internet.
