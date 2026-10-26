# Infrastructures IA clients

Le bouton **Créer une infra IA** prépare un projet client complet : **Caddy → Open WebUI → vLLM**, avec **PostgreSQL**, les documents/index et les caches de modèles persistants. Le profil vise Docker Tracer installé directement sur le serveur **Ubuntu, Docker Linux, GPU NVIDIA**, sur **LAN ou VPN**. La préparation et les tests peuvent se faire sur le PC Windows avec Docker Desktop. Les cibles SSH restent disponibles.

## Parcours graphique

L’assistant comporte quatre étapes. Les options détaillées restent dans des volets ; les choix existants sont conservés quand on les referme.

1. **Ton projet** : saisir un nom et l’email du premier administrateur. Le mot de passe est généré et consultable. Le serveur local est proposé directement ; **Organisation et serveurs distants** permet de changer de cible. Ajouter au préalable une cible SSH dans **Tout Docker → Mes serveurs** et vérifier son empreinte.
2. **Modèle & matériel** : choisir parmi cinq Qwen et cinq Mistral ou saisir son identifiant Hugging Face, puis cocher les GPU NVIDIA détectés. Les volets **CPU et mémoire**, **Stockage des modèles** et **Réglages du moteur** permettent de personnaliser les limites, le disque Ubuntu, les versions et la compatibilité WSL. Chaque présélection indique si elle accepte des images. Le mode chat simple facilite l’essai ; les outils exigent un modèle compatible. Les dix présélections ne sont pas toutes validées par les essais réels : voir la section de vérification.
3. **Accès & options** : renseigner le DNS/IP et le certificat Caddy. Ouvrir **Ports et adresse d’écoute** pour changer les ports ou l’interface LAN/VPN. **Documents et outils** rassemble les options documentaires et API. Les URL entre services et leurs contrôles suivent les changements de ports internes.
4. **Vérifier & déployer** : relire le résumé et l'espace disque prévu, puis **Créer et déployer**. Le logiciel vérifie l'espace avant de créer le projet, vérifie la configuration et lance réellement Compose, avec progression et contrôles de santé. **Enregistrer sans déployer** reste disponible, même si le disque manque de place. Un échec de déploiement conserve le projet pour le corriger et réessayer, sans créer de doublon.

Depuis la carte IA, **Déployer l’IA maintenant** lance la configuration enregistrée ; **Appliquer les réglages IA** met à jour une infrastructure existante. Le premier téléchargement peut être long. Un clic sur une machine ouvre ses actions et les rubriques Image, Ressources, Ports, Réseaux, Stockage, Variables et Avancé. **Modifier le modèle, le matériel ou HTTPS** rouvre l’assistant IA, dont le bouton principal applique désormais les changements. L’assistant conserve volumes, secrets et ajouts manuels non gérés ; il refuse d’écraser silencieusement un champ géré déjà modifié dans Compose.

## Ressources automatiques et catalogue

Le catalogue contient **cinq Qwen et cinq Mistral**, chacun avec une indication texte/vision, la précision et la taille du checkpoint. Les modèles personnalisés restent disponibles. Voir [AI-MODELS.md](AI-MODELS.md) pour les références officielles et les limites. Les poids seuls ne garantissent pas le démarrage : le contexte, le cache et la vision consomment aussi de la mémoire.

Parcourir le catalogue ne télécharge aucun modèle ni image. Le récapitulatif indique les seuls services sélectionnés et le modèle à charger. Docker réutilise les images disponibles sur le serveur (les références flottantes comme `latest` peuvent être revérifiées). Les poids restent dans le stockage du projet ; ce cache n'est pas automatiquement partagé entre projets ou serveurs. Le modèle documentaire peut également être téléchargé si la recherche documentaire l'exige. Utiliser une base externe exclut l'image PostgreSQL locale des services à installer.

Le contrôle du stockage lit le disque physique de Docker et l'inventaire local des images, sans téléchargement. Il additionne les images connues absentes, les poids du seul modèle sélectionné et une réserve de 10 Gio. Les services dans un profil Compose inactif sont exclus. Le cache des poids n'étant pas vérifié, ceux-ci restent comptés par prudence. Cette estimation ne réserve pas d'espace : les transferts temporaires et les autres applications peuvent demander davantage. Un nouveau relevé est effectué au clic sur le bouton, puis le serveur vérifie encore avant Compose.

Un manque confirmé bloque le déploiement et laisse la sauvegarde du brouillon disponible. Les cibles distantes, dossiers de modèles personnalisés, images ou constructions de taille inconnue restent indiqués comme non entièrement vérifiés ; l'assistant demande de vérifier ces éléments sur le serveur avant de poursuivre. Un dossier personnalisé peut partager le disque de Docker : il faut alors additionner les deux besoins. Une erreur de l'API de vérification ne peut pas être remplacée par cette confirmation.

Le compte administrateur initial accepte un mot de passe choisi de 8 à 72 caractères, sans règle de majuscules ni de symboles. Les boutons afficher, copier et générer facilitent sa transmission. Les secrets techniques restent distincts et aléatoires. Cette valeur initialise une base vide ; le client change ensuite son mot de passe dans Open WebUI.

Le mode automatique utilise tous les CPU attribués à Docker et la RAM disponible après réserve pour WebUI et le système (au moins 2 Gio ou 10 %). Pour chaque GPU sélectionné, il conserve au moins 1 Gio ou 5 % de marge sur la mémoire libre relevée et ne dépasse pas 90 % de la VRAM totale. Les valeurs sont des plafonds, sans réservation exclusive. Une mesure manquante ou insuffisante demande un choix manuel. Les infrastructures existantes gardent leurs limites jusqu’à une modification explicite.

Les nouveaux projets proposent des ports non publiés par les conteneurs actuellement en marche. La validation avant déploiement vérifie de nouveau les collisions ; un autre processus ou un changement entre-temps peut encore occuper le port.

## PostgreSQL externe

Dans **Accès & options → Base de données**, choisir la base intégrée ou un serveur PostgreSQL externe. Renseigner son hôte, port, nom de base, utilisateur, mot de passe et mode TLS. La base dédiée doit déjà exister et être accessible depuis les conteneurs. `localhost` désigne le conteneur WebUI, pas le serveur PostgreSQL ; utiliser une adresse accessible depuis Docker.

Le mode externe ne crée pas de service PostgreSQL local. Les identifiants sont encodés dans une variable séparée, sans mot de passe littéral dans le YAML. Changer de cible ne migre pas les comptes ni les conversations : effectuer la migration séparément si nécessaire. Le volume de la base intégrée existante est conservé et son ancien conteneur peut rester orphelin selon Compose ; aucune donnée n’est automatiquement supprimée.

## Accès privé et certificats

- **Autorité locale Caddy** : certificat généré sur le serveur. Après un déploiement réussi, **Réglages IA → Accès & options → Télécharger le certificat racine déployé** récupère uniquement le certificat public de l’autorité. Installer cette autorité sur les postes clients reste une intervention à effectuer dans leur magasin de certificats. Le logiciel ne change pas leur confiance système.
- **Certificat fourni** : importer le certificat/chaîne PEM et la clé PEM non chiffrée. La préparation vérifie la lecture, la correspondance clé/certificat, les dates et le nom couvert. La confiance des postes dans la chaîne et le renouvellement restent à gérer chez le client.
- **Certificat public** : ce profil exige un domaine public et les ports 80/443 joignables pour ACME. La configuration d’un challenge DNS par fournisseur n’est pas incluse.

Pour le LAN/VPN, définir le nom dans le DNS du client et indiquer l’adresse privée du serveur comme interface d’écoute. `127.0.0.1` réserve l’accès au serveur ; `0.0.0.0` écoute sur toutes les interfaces et ne constitue pas une restriction au VPN. Docker Tracer ne configure pas automatiquement le pare-feu, le VPN ou le DNS. Le moteur et la base n’ont aucun port publié par le profil.

## Modèles, documents et outils

La détection lit les CPU/RAM attribués à Docker et les cartes du pilote NVIDIA (`nvidia-smi`) : nom, UUID, VRAM totale/libre, activité et version du pilote. Les cartes choisies sont attribuées à vLLM par UUID. Les limites CPU/RAM deviennent `cpus` et `mem_limit` dans Compose ; ce sont des plafonds, pas une réservation exclusive des composants. La préparation refuse des budgets supérieurs aux ressources du moteur Docker.

Sous Ubuntu, la détection native exige que Docker Tracer s’exécute sur le même hôte que le moteur local, hors conteneur. Les systèmes de fichiers locaux montés en écriture sont proposés pour les poids des modèles. Le dossier dédié est `<disque>/docker-tracer/<projet>/models` ; les autres données restent dans les volumes Docker. Le changement de disque d’un projet existant est bloqué dans l’assistant : il nécessite une migration séparée pour conserver les données. L’espace prévu n’est pas un quota ni une réservation.

Sous Windows, les GPU sont ceux du PC et les budgets CPU/RAM ceux de la VM Docker Desktop. Les modèles utilisent le stockage Docker ; le menu ne transforme pas un disque Windows en chemin Linux. La détection native d’un serveur SSH, d’un moteur non identifié ou depuis un conteneur n’est pas prise en charge : aucune ressource du PC n’est présentée comme celle du serveur distant, et une saisie manuelle est proposée.

Le profil Windows propose **Compatibilité Docker Desktop / WSL** dans les réglages du moteur. Cette option sélectionne le moteur vLLM V1 (`VLLM_USE_V2_MODEL_RUNNER=0`) pour éviter l’échec « UVA is not available » rencontré avec vLLM 0.29 sur ce PC. Elle est proposée automatiquement pour un nouveau projet détecté sur Windows et reste désactivée sur Ubuntu natif. Elle ne transforme pas Windows en environnement de production validé. [Incident amont vLLM](https://github.com/vllm-project/vllm/issues/50239).

Les relevés sont ponctuels, actualisables à la demande. Lire une carte via le pilote ne prouve pas que vLLM fonctionne dans Docker. Ubuntu, Docker/Compose, le pilote NVIDIA et NVIDIA Container Toolkit doivent déjà être fonctionnels ; Docker Tracer ne les installe pas.

Le démarrage simple (`--enforce-eager`) évite la compilation et les graphes CUDA, au prix d’un débit potentiellement inférieur. Il est proposé pour les essais Windows. Les nouveaux projets accordent 20 minutes de démarrage par service, modifiables entre 2 et 30 minutes. Le délai global de déploiement IA est de 90 minutes, téléchargements compris. Open WebUI réutilise par défaut son modèle documentaire en cache ; les poids nécessaires sont toujours téléchargés à la première installation.

**Fonctionnement du modèle** propose le chat simple (outils intégrés automatiques désactivés) ou le chat avec outils. Dans ce dernier mode, le profil configure conjointement les capacités Open WebUI et `--enable-auto-tool-choice --tool-call-parser` de vLLM. Les Qwen proposés utilisent `hermes` ; un modèle personnalisé doit accepter le format choisi. Les petits modèles peuvent être validés en chat simple, sans promettre la recherche agentique ou les appels d’API. Connecter une API dans l’assistant exige le mode avec outils. Les anciens profils n’ajoutent aucun réglage implicitement ; choisir explicitement un mode pour les mettre à jour. Les personnalisations par modèle dans Open WebUI peuvent remplacer les valeurs globales. [Outils Open WebUI](https://docs.openwebui.com/features/extensibility/plugin/tools/), [formats vLLM](https://docs.vllm.ai/en/latest/features/tool_calling/).

Le calcul de poids utilise les tailles de checkpoint documentées pour le catalogue, et une approximation `paramètres × 2 octets` pour les modèles personnalisés. Les checkpoints Ministral FP8 peuvent inclure des composants BF16 ; leur taille complète est comptée. Le budget multi-GPU utilise la plus petite VRAM de la sélection pour éviter de sommer abusivement des cartes différentes. Il exclut le cache KV, le contexte et la surcharge du moteur ; il ne prédit pas le nombre d’utilisateurs servis ni le débit. Le profil propose FP16/BF16/auto. Les quantifications personnalisées, AMD/ROCm, CPU seul et le calcul réparti sur plusieurs serveurs nécessitent une configuration adaptée et des essais spécifiques.

Le RAG est celui d’Open WebUI : embeddings locaux SentenceTransformers, index Chroma dans le volume applicatif. Importer les documents, définir les espaces de connaissances et leurs permissions dans Open WebUI. Changer d’embeddings nécessite de réindexer. Les serveurs d’outils OpenAPI / MCPO doivent exister et être accessibles depuis les conteneurs ; leur installation et leurs autorisations métier ne sont pas générées par le profil.

Les téléchargements initiaux des images, modèles et embeddings utilisent les registres/Hugging Face. Ce n’est pas un profil hors ligne. Après téléchargement, le modèle et les embeddings sont exécutés localement ; les outils externes peuvent recevoir les informations nécessaires à leurs appels. Le jeton Hugging Face facultatif permet l’accès aux modèles restreints dont l’utilisateur possède les droits.

## Exploitation

- Un compte administrateur initial est créé à l’initialisation d’une base vide. Les inscriptions sont fermées. Gérer ensuite comptes, rôles et changements de mots de passe dans Open WebUI. Changer une variable PostgreSQL ne change pas le mot de passe d’une base déjà créée.
- Les paramètres Open WebUI sont pilotés par le profil (`ENABLE_PERSISTENT_CONFIG=false`). Les changements de configuration administrative faits dans Open WebUI ne survivent pas au redémarrage ; les comptes, conversations et documents restent persistants.
- Six volumes nommés par projet conservent la base, les documents/index, les poids, le cache vLLM et les données/configuration Caddy. Arrêter/libérer ne signifie pas sauvegarder. Prévoir des dumps PostgreSQL, une sauvegarde cohérente des documents/certificats et un essai de restauration avant une mise à jour de production.
- Les secrets sont aléatoires et absents des valeurs littérales du YAML généré ; ils sont stockés dans les variables du projet local et injectés par Compose sur la cible. Le magasin local n’est pas chiffré. Les comptes ayant accès à Docker ou aux fichiers de Docker Tracer peuvent accéder aux secrets. Ne pas envoyer le dossier `data` ou une configuration résolue à un tiers.
- Les images sont éditables. Les tags de départ ont été vérifiés comme publiés, mais une version publiée ne prouve pas la compatibilité de toute la chaîne. Les mises à jour de versions, migrations PostgreSQL, rotation de secrets, SSO et sauvegardes planifiées nécessitent une procédure dédiée.
- Un projet reste lié à un serveur. Préparer un autre projet pour un autre client. La gestion des clients est actuellement celle des projets locaux ; il n’y a pas encore de coffre central, RBAC d’équipe, haute disponibilité ou supervision d’un parc avec SLA.

## Validation de cette livraison

- Tests unitaires : génération, isolation, secrets, validation des entrées, ports/GPU propagés, conservation des ajouts manuels et refus de conflits.
- Docker Compose réel : validation du profil NVIDIA généré, sans télécharger ni lancer vLLM.
- Docker réel : Caddy + PostgreSQL ; HTTPS avec vérification de la CA, export public de la CA, certificat fourni/nom couvert, redirection vers un port personnalisé, persistance SQL après recréation et absence de ports internes publiés. Open WebUI et vLLM sont remplacés par des doublures HTTP pour ce test réseau.
- Navigateur : bouton, création d’un projet temporaire, vérification de l’hôte, GPU/modèle, ports, ouverture de la carte, modification et persistance après rechargement.
- Essais réels sur un poste de test Windows avec Docker Desktop et GPU NVIDIA : trois projets créés et déployés depuis le navigateur avec Qwen2.5-0.5B, Qwen2.5-1.5B et SmolLM2-135M, hors présélections. Connexion aux trois Open WebUI et réponses produites par les vrais modèles. Le dialogue Qwen1.5B conserve son contexte et survit au redémarrage de WebUI. Les trois Caddy servent réellement WebUI en HTTPS avec CA vérifiée. Les premiers appels sont lents et la réponse de SmolLM2 reste imprécise. Ces résultats historiques doivent être reproduits avant tout déploiement de production.
- La chaîne réelle Open WebUI/vLLM/Qwen, le RAG et les outils ne sont **pas encore validés de bout en bout** sur un serveur Ubuntu/NVIDIA client. La charge multi-utilisateurs, les restaurations client et la compatibilité de son matériel restent à mesurer avant une livraison de production.

Commandes de vérification : `npm test`, `npm run build`, `npm run test:ai:docker`, `npm run test:compose:docker`. Le test `npm run test:ai:hardware` vérifie un vrai GPU détecté et les plafonds CPU/RAM dans un conteneur jetable sans réseau ; il nécessite l’image `ollama/ollama:latest` déjà présente et ne lance aucune inférence.

## Références officielles consultées

- [vLLM dans Docker](https://docs.vllm.ai/en/latest/deployment/docker/)
- [Variables vLLM](https://docs.vllm.ai/en/latest/configuration/env_vars/)
- [Configuration Open WebUI](https://docs.openwebui.com/reference/env-configuration/)
- [Durcissement Open WebUI](https://docs.openwebui.com/getting-started/advanced-topics/hardening/)
- [Certificats Caddy](https://caddyserver.com/docs/caddyfile/directives/tls)
- [Caddy en conteneur et confiance locale](https://caddyserver.com/docs/running)
- [Secrets Compose](https://docs.docker.com/reference/compose-file/secrets/)
- [Modèle Qwen3-8B](https://huggingface.co/Qwen/Qwen3-8B)
- [Modèle Qwen3-0.6B](https://huggingface.co/Qwen/Qwen3-0.6B)
- [Relevés NVIDIA SMI](https://docs.nvidia.com/deploy/nvidia-smi/)
- [GPU et Compose](https://docs.docker.com/compose/how-tos/gpu-support/)
- [Ressources et montages Compose](https://docs.docker.com/reference/compose-file/services/)
