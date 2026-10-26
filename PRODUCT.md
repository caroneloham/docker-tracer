# Direction de Docker Tracer

La promesse : **maintenir, modifier et faire évoluer une infrastructure Docker depuis sa carte**. AutoDocker prend en charge la génération initiale ; Docker Tracer permet ensuite de retrouver les services, comprendre leurs échanges et intervenir sur le bon conteneur. Le visuel classique validé sert l’espace de travail. La gestion quotidienne reste l’objectif ; le diagnostic est un de ses outils.

## Direction actuelle : agir sur l’existant

L’entrée principale est **Tout Docker**. L’utilisateur choisit son serveur, retrouve une application et ouvre sa gestion depuis la carte. **Rattacher une infrastructure** importe le Compose existant et son nom de projet exact sans modifier les conteneurs. Les boutons de génération d’infrastructure et d’infrastructure IA sont retirés de ce parcours. Le passage depuis AutoDocker repose pour l’instant sur le fichier Compose ; aucune synchronisation de compte ou de projet en ligne n’est annoncée.

**Ajouter un conteneur** fait évoluer un serveur ou un projet existant. Le catalogue recherche les images publiques sur Docker Hub, affiche des cartes et leurs versions, et accepte une référence manuelle pour les autres registres. Il consulte uniquement des métadonnées paginées et mises brièvement en cache. Ni recherche ni préparation d’un ajout ne téléchargent d’images. Le téléchargement des éléments manquants intervient à l’application des changements ; les politiques des services déjà importés sont conservées. L’outil n’indexe pas tout Docker Hub et ne promet pas une configuration automatique adaptée à chaque image.

Un clic ouvre la gestion ; le **clic droit** donne accès au terminal, aux fichiers, aux logs, aux ports et à la capture ciblée. Le terminal interactif conserve le shell, son dossier courant et ses variables. La saisie directe, Entrée, Tab, l’historique et les séquences ANSI passent par un vrai terminal Docker, dont la taille suit l’affichage. Le bouton **Interrompre** reste disponible si le navigateur intercepte Ctrl+C ; les programmes doivent être installés dans l’image. Les fichiers existants ordinaires UTF-8 sont éditables jusqu’à 256 Kio, avec vérification des conflits ; les modifications hors stockage persistant peuvent disparaître à la recréation. Les ports et autres changements structurels passent par le brouillon et l’aperçu des remplacements. Un conteneur externe doit être rattaché à son Compose pour une modification durable de sa configuration.

La carte sépare les réseaux configurés, les connexions attendues et les échanges capturés. **Observer les flux · 30 s** ouvre une collecte ciblée et bornée avec arrêt manuel. Une session active peut animer ses enveloppes ; une session terminée reste visible comme historique, en pointillé, et conserve ses preuves. Le logiciel ne représente pas tous les paquets de tous les conteneurs en permanence et ne déduit pas le trafic d’une simple liaison Docker.

Les infrastructures IA existantes restent gérables : Caddy, Open WebUI, vLLM, modèles, matériel et base de données. Les projets déjà reconnus conservent leurs réglages spécialisés ; un Compose externe utilise aussi les éditeurs génériques. La priorité porte sur les changements vérifiables, la préservation des données et la lisibilité des cibles. Les limites détaillées de chaque outil sont dans `README.md` ; le périmètre des contrôles actuels est résumé dans `VERIFICATION.md`.

## Historique : version 0.12 et personnalisation des réseaux

La 0.12 a introduit des recettes d’applications avec grandes icônes et installation guidée, aujourd’hui retirées de l’entrée recommandée au profit de la maintenance. Les projets créés avec ces recettes restent ouverts et modifiables. Les essais historiques ont couvert la conservation de bases lors de recréations, une collision de port puis sa correction et la persistance.

Les réseaux Compose conservent des noms lisibles, notes, couleurs et listes de services, puis des réglages d’isolation, plages IP, IPv6, MTU, communication directe et NAT. La personnalisation visuelle ne remplace pas les conteneurs ; les changements du réseau réel gardent les contraintes de recréation de Compose. L’éditeur de laboratoire historique reste à harmoniser avec ce formulaire. Les sections suivantes décrivent les livraisons successives ; leurs anciennes priorités ne remplacent pas la direction actuelle.

## Version 0.11 : reprendre Compose et le gérer depuis la carte

L’import garde le fichier complet et propose la configuration graphique des champs courants, une palette de services/réseaux/volumes, les actions et logs, une validation et simulation Compose, puis un déploiement réel local ou SSH. Les résultats persistent et l’ancienne configuration appliquée peut être reprise dans un brouillon. Le style de carte conserve les pictogrammes et câbles droits de l’éditeur classique.

Les tests locaux et SSH avec un CLI Linux isolé couvrent aussi builds, dépendances de santé et fichiers montés. La simulation qui échoue est annoncée comme telle ; un déploiement Compose échoué n’est pas présenté comme restauré. L’édition des options avancées passe encore par le YAML dans l’interface. Les fichiers inclus restent dans le dossier source, les sauvegardes Compose et les reprises après interruption restent à intégrer. Aucun NAS/VPS indépendant ni panel d’utilisateurs n’a validé cette version.

La proposition de catalogue d’installation évoquée en 0.11 a été livrée ensuite, puis remplacée dans le parcours principal par le rattachement et l’ajout ciblé de conteneurs. L’import Compose et la conservation des réglages restent le socle de l’édition de l’existant.

## Version 0.10 : préserver et retrouver ses données depuis la carte

Le gestionnaire de volumes sauvegarde les données d’un service local ou SSH après aperçu des interruptions. Il conserve une archive vérifiée sur le PC, reprend les services initialement actifs et permet de télécharger l’archive même si l’hôte est indisponible.

La restauration prépare un volume neuf et réutilise l’aperçu des changements, les contrôles de démarrage et la restauration des anciens conteneurs en cas d’échec. Le volume précédent reste conservé. Le parcours graphique a retrouvé une valeur Redis sauvegardée après sa modification, avec un service remplacé et trois conservés. Les essais locaux/SSH couvrent aussi des données binaires, permissions, liens, archives altérées, limites de stockage et reprise explicite de services après interruption enregistrée.

La couverture reste celle des volumes locaux gérés par un projet, un volume à la fois. L’import graphique d’une archive externe, les sauvegardes cohérentes de plusieurs volumes, la planification, le chiffrement, les destinations distantes et la reprise transactionnelle du déploiement restent à construire. L’objectif de gestion d’une infrastructure complète n’est pas encore atteint.

## Version 0.9 : vérifier une modification avant de perdre l’ancienne version

L’onglet Validation permet de définir ce qui doit réussir au démarrage : processus stable, santé native de l’image, port TCP ou réponse HTTP précise. Les services sont démarrés avant les contrôles ; les anciens conteneurs restent disponibles pour une restauration tant que les contrôles demandés n’ont pas réussi. Les conteneurs arrêtés ne sont pas démarrés implicitement.

Les échecs ouvrent leur rapport, avec observations, logs et résultat de restauration. L’historique survit à la réouverture sans changer la révision du schéma. Une panne de sonde reste distincte d’un échec applicatif constaté. Les essais locaux/SSH ont vérifié une configuration Nginx invalide et une réponse 503, puis le retour à l’ancienne version et une correction valide.

Le contrôle décrit une période de démarrage ; il ne garantit pas la disponibilité future et ne restaure pas les écritures dans les volumes. La reprise automatique après interruption et les sauvegardes restent nécessaires. Les contrôles sont propres au déploiement Docker Tracer et ne sont pas exécutés par Compose.

## Version 0.8 : fichiers applicatifs et reverse proxy graphique

Chaque service peut recevoir ses fichiers texte depuis l’interface. Ils restent dans le projet et ses exports, sont transférés directement au conteneur avant démarrage, en local comme par SSH, et participent à l’aperçu des changements. Les volumes de données ne sont pas écrasés par cet éditeur.

L’assistant Nginx permet de choisir un service cible et son réseau sur la carte. Il produit la configuration et la liaison, suit les renommages et propose de passer en édition libre. Le test réel traverse le proxy, lit la page personnalisée, puis valide une mise à jour de cette page avec le proxy conservé. La capture graphique montre les deux échanges HTTP.

Les secrets, fichiers binaires, gestion automatique de certificats, import Compose préservant toutes les options et sauvegardes de volumes restent nécessaires pour couvrir une infrastructure complète. La 0.9 ajoute les contrôles de démarrage avant validation du remplacement ; l’analyse de syntaxe avant démarrage reste à construire.

## Version 0.7 : plusieurs infrastructures avec une cible explicite

Création, copie, ouverture, archivage et restauration depuis un gestionnaire graphique. Chaque projet cible un serveur local ou SSH et conserve ses résultats de tests. Le dessin devient déployable sur ce serveur avec les mêmes réglages et les mêmes opérations progressives. Les brouillons et révisions évitent les pertes lors du changement de projet ou depuis une autre fenêtre.

La validation réelle comprend deux projets, dont un déployé et modifié à travers un endpoint SSH authentifié relié au moteur local. La coupure de ce transport ne touche pas l’autre projet. Le parcours graphique couvre création, déploiement, test ICMP avec capture du TTL choisi, copie, sauvegarde et réouverture de l’historique. Deux machines SSH indépendantes restent à tester.

L’intérêt concret recherché est de passer de « dessiner un laboratoire » à « retrouver, gérer et vérifier chacune de ses infrastructures ». L’avantage face aux autres logiciels reste à mesurer avec des utilisateurs.

## Version 0.6 : construire et modifier graphiquement

Réglages des images, variables, ports TCP/UDP, volumes, limites CPU/mémoire/processus, redémarrage et DNS depuis des formulaires partagés avec les modèles. Connexions par cases à cocher ou câbles, alias et IP fixes, duplication d’équipements, export Compose.

Le laboratoire déployé reste modifiable. Un aperçu présente les services remplacés, créés ou supprimés ; les autres conservent leur conteneur et leur disponibilité. Les images sont préparées avant l’arrêt, les anciens conteneurs sont conservés pendant l’application pour tenter une restauration après erreur, les volumes nommés restent présents. Les changements de CIDR/isolation de réseaux existants, la reprise après interruption brutale et les migrations de données demandent encore du travail.

Depuis la 0.7, la création couvre plusieurs projets locaux/SSH, de 32 équipements chacun. La 0.8 ajoute les fichiers applicatifs ; l’import Compose préservant les options existantes, les secrets et sauvegardes de volumes restent à construire.

## Les outils proches

[Portainer](https://docs.portainer.io/user/docker/networks) couvre notamment la gestion des réseaux Docker. [Dockge](https://github.com/louislam/dockge) propose un éditeur et un gestionnaire de projets Compose, un terminal et plusieurs agents. La facilité d’utilisation existe déjà chez ces outils ; notre différenciation doit se vérifier dans des parcours concrets.

Nous orientons Docker Tracer autour de la topologie comme interface principale : comprendre les connexions, intervenir sur le bon service, faire évoluer sa configuration puis vérifier les échanges réels. L’intérêt face aux autres outils doit se démontrer dans ce parcours, avec des utilisateurs et des mesures.

## Version 0.5 : lots A, B et C intégrés

Public prioritaire : homelab et auto-hébergement, puis équipes techniques et enseignement. La démonstration à valider : connecter un serveur existant, retrouver une application en panne, comprendre l’échange qui échoue et vérifier sa correction depuis la même carte.

- Lot A : profils locaux/SSH, confiance explicite dans les empreintes, inventaires indépendants, identité des ressources par hôte, arbre serveur/projet et services sur la carte.
- Lot B : connexions attendues persistantes, diagnostics structurés et preuves, sonde temporaire dans l’espace réseau source, résultats réussi/échoué/non concluant et comparaison avant/après.
- Lot C : captures ciblées et bornées, enveloppes groupées, export PCAP, association prudente aux diagnostics, logs et actions par service, rejeu des contrôles après action, suggestions Compose sans réécriture des projets externes.

La validation locale réelle a réussi le 11 septembre : sept diagnostics, captures de deux espaces réseau, PCAP et nettoyage des sondes. Aucun hôte NAS/VPS SSH n’a été fourni. Les tests SSH utilisent deux serveurs éphémères sur la boucle locale et des moteurs simulés. Cette validation historique doit être reproduite sur chaque hôte cible.

### Fonctions conservées de la version 0.4

- Préparer un test ICMP, HTTP, DNS, TCP ou UDP depuis l’enveloppe, lire son résultat puis le modifier ou le relancer.
- Ouvrir les paquets capturés par couche, comprendre les erreurs visibles et rejouer leur animation à vitesse réglable.
- Enregistrer ses propres images et configurations comme modèles réutilisables dans la palette, y compris depuis un équipement existant.

## Découverte livrée en 0.3

- Découvrir le moteur Docker local sans importer de fichier ni redessiner l’existant.
- Retrouver un service ou une IP, filtrer un projet et voir son voisinage.
- Consulter les connexions, ports, états de santé et métriques d’un équipement.
- Revenir au laboratoire de conception et à ses commandes sans perdre les modifications en cours.

Depuis la 0.5, la vue globale donne également accès aux actions et captures ciblées des services externes.

## Priorités fonctionnelles suivantes

1. **Fiabiliser la maintenance et les évolutions.** Ajouter un service, modifier un port, un réseau ou une configuration, identifier les interruptions et vérifier le résultat depuis la même carte. Renforcer les sauvegardes de projets Compose, la reprise après interruption, les migrations de données et la gestion des secrets. La génération d’infrastructures complètes appartient au parcours AutoDocker.
2. **Travail en équipe.** Ajouter un espace partagé, des permissions, un journal d’actions et des rapports d’incident. La première version reste locale pour un utilisateur.
3. **Une vue lisible à grande échelle.** Regrouper les projets, développer un groupe à la demande, rechercher une IP et cibler les captures. Conserver un inventaire léger, puis lire les métriques et paquets détaillés quand l’utilisateur les demande.
4. **Apprentissage.** Réutiliser les contrôles et diagnostics pour des scénarios de panne, exercices et explications progressives.

Kubernetes, la découverte physique du LAN, la simulation complète de routeurs et un assistant IA restent hors de cette première livraison.

## Vérifier la simplicité et les performances

- Exécuter `npm run test:workspace:docker` sur un moteur Linux opérationnel, puis tester deux moteurs Linux indépendants via SSH avec des projets externes.
- Faire tester trois pannes à cinq utilisateurs de homelab : au moins quatre doivent retrouver le service en moins d’une minute et identifier le problème en moins de cinq minutes, sans assistance. Cette étude n’a pas encore eu lieu.

- Un nouvel utilisateur doit pouvoir ouvrir l’outil, retrouver un service et consulter ses connexions sans lire une documentation technique.
- Vérifier qu’un ajout depuis le catalogue respecte le serveur et le projet choisis, ne télécharge rien avant application et conserve les options des services existants.
- Tester le parcours clic droit → terminal ou fichier → correction → contrôle réseau, y compris image sans shell, conteneur arrêté, coupure SSH et conflit d’édition.
- Vérifier qu’une capture arrêtée reste identifiable comme historique et qu’aucun nouveau trafic n’est inventé lors d’un rechargement.
- Mesurer séparément le temps de découverte Docker, la génération du graphe, la fluidité du navigateur et le coût de la capture.
- Les tests de calcul sur 1 000 conteneurs simulés ne constituent ni un test de 1 000 conteneurs réels ni une mesure de FPS.
- Ne pas inspecter et capturer tous les conteneurs en permanence pour remplir une vue d’ensemble.
