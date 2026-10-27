# Dépannage Docker Tracer

Commencez par relever la version, le message exact et le mode utilisé : [atelier navigateur](https://autodocker.eu/essai/tracer/) ou application locale Windows/Linux. Vérifiez les [versions publiées](https://github.com/caroneloham/docker-tracer/releases) et conservez vos données avant toute manipulation.

## Trouver le bon cas

| Symptôme | Où regarder |
| :--- | :--- |
| Runtime Node.js absent, lancement impossible ou erreur Linux | [Lancement](#lapplication-ne-démarre-pas) |
| Port 4310 occupé ou page inaccessible | [Port local](#port-4310-occupé-ou-page-inaccessible) |
| Accès refusé après ouverture d’un ancien lien | [Session](#session-refusée-ou-lien-déjà-utilisé) |
| Le Compose ne s’importe pas ou sa carte semble incomplète | [Import et carte](#le-compose-ne-simporte-pas) |
| Docker, SSH, journaux ou terminal indisponibles | [Connexion au moteur](#docker-ou-ssh-ne-fonctionne-pas) |
| Le travail n’est plus visible après fermeture | [Conservation des données](#le-travail-a-disparu-ou-un-export-ne-souvre-pas) |

## L’application ne démarre pas

1. Téléchargez le paquet adapté à **Windows x64** ou **Linux x64**, puis extrayez-le entièrement dans un dossier où vous pouvez écrire. Ne démarrez pas depuis l’intérieur du ZIP.
2. Utilisez `Docker-Tracer.cmd` sous Windows, ou `./Lancer-Docker-Tracer.sh` sous Linux.
3. Le message **« Runtime Node.js absent »** indique que `runtime/node.exe` ou `runtime/node` manque, ou que le runtime Linux n’est pas exécutable. Réextrayez l’archive complète. Node.js est inclus dans le paquet : une installation npm n’est pas nécessaire pour le lancer.
4. Si Windows bloque le fichier, consultez le message de protection et vérifiez la provenance ainsi que le SHA-256 avec `SHA256SUMS.txt` de la release. Sur un poste géré, demandez à l’administrateur ; ne désactivez pas la protection pour contourner le blocage.

Sous Linux, ouvrez un terminal dans le dossier du paquet :

```sh
uname -m
ldd --version
```

Le paquet demande Linux **x64** (`x86_64`) et glibc **2.28 ou plus récente**. Une erreur `GLIBC_x.y not found` ou `Exec format error` peut indiquer une incompatibilité de système ou d’architecture ; comparez le message aux prérequis de la release.

Si seul le script n’est pas exécutable, essayez `sh ./Lancer-Docker-Tracer.sh`. Si le runtime ne l’est pas non plus, le script lancé avec `sh` ne répare pas ses droits. Pour une archive officielle extraite dans votre dossier personnel, rétablissez uniquement les droits des fichiers concernés :

```sh
chmod u+x ./Lancer-Docker-Tracer.sh ./runtime/node
```

Si le disque interdit l’exécution, extrayez le paquet dans un dossier personnel sur un système de fichiers qui l’autorise. Ne lancez pas toute l’application en administrateur ou avec `sudo` comme premier réflexe.

Les journaux du paquet se trouvent dans **`data/server.log`** et **`data/server-error.log`**. Lisez les dernières lignes utiles avant une nouvelle tentative, sans partager les fichiers complets.

## Port 4310 occupé ou page inaccessible

Le serveur local utilise `127.0.0.1:4310`. Le lanceur peut rouvrir une instance reconnue du même paquet. Si le message indique **« serveur non identifié »** ou **« autre processus »**, il refuse de réutiliser ce qui occupe le port.

Pour regarder sans arrêter de processus :

**PowerShell Windows :**

```powershell
Get-NetTCPConnection -LocalPort 4310 -State Listen -ErrorAction SilentlyContinue |
  Select-Object LocalAddress, LocalPort, OwningProcess
```

**Linux, si `ss` est disponible :**

```sh
ss -ltnp 'sport = :4310'
```

Sous Windows, `OwningProcess` donne le PID : retrouvez-le dans l’onglet **Détails** du Gestionnaire des tâches pour identifier le programme.

Si vous reconnaissez votre ancienne instance, utilisez **Fermer-Docker-Tracer.cmd** ou `./Fermer-Docker-Tracer.sh` dans son dossier, puis relancez le paquet voulu. N’arrêtez pas un programme inconnu et ne supprimez pas `server.pid` ou `server.reopen` pendant que le serveur tourne.

## Session refusée ou lien déjà utilisé

Le lien initial sert une seule fois à activer la session. Une ancienne URL contenant `?access=...` ne doit pas être partagée ni réutilisée comme favori.

1. Relancez le lanceur du **même dossier**. Il peut créer un nouveau lien pour l’instance déjà ouverte.
2. Utilisez l’onglet ouvert automatiquement ou l’adresse complète imprimée lorsque le navigateur ne peut pas s’ouvrir.
3. Gardez le même navigateur et autorisez les cookies nécessaires à l’adresse locale.
4. Si la réouverture échoue, arrêtez avec le script fourni, puis relancez normalement. Conservez `data/` et ses projets.

Sous Windows, le secret de réouverture appartient au compte utilisateur qui a lancé le paquet. Utiliser le même dossier depuis un autre compte peut empêcher sa lecture. Ne modifiez pas les contrôles d’accès pour contourner cette protection.

## Le Compose ne s’importe pas

1. Utilisez **Importer un Compose** ou déposez **un seul** fichier `.yaml` ou `.yml` dans la zone d’import. La limite indiquée dans cette zone est **2 Mio** ; un projet JSON relève d’un autre format.
2. Corrigez l’indentation YAML et les erreurs indiquées. Le fichier doit décrire des services Compose, pas seulement une configuration isolée d’un conteneur.
3. Dans l’atelier navigateur, les références `include`, `extends`, `.env`, `env_file` et les contextes de construction ne chargent pas automatiquement les fichiers de votre disque. Une importation du YAML seul ne reconstitue pas tout le dossier du projet.
4. Si nécessaire, faites préparer une copie Compose autonome par la personne qui maintient l’infrastructure, en gardant les valeurs sensibles hors des exemples partagés.

Si la carte semble vide, utilisez le contrôle de cadrage de la carte, vérifiez le zoom et consultez l’onglet de configuration complète pour confirmer la présence des services. Si la carte plante avec un fichier particulier, joignez à une issue un exemple minimal sans secrets.

La mention **« Dans le fichier »** décrit une déclaration Compose. Elle ne prouve pas que le conteneur est démarré. L’atelier navigateur ne propose pas l’état réel, le terminal ou les opérations sur un moteur Docker.

## Docker ou SSH ne fonctionne pas

Pour l’application locale, démarrez le moteur et vérifiez avec le même utilisateur :

```sh
docker info
docker compose version
```

Si ces commandes échouent, corrigez d’abord le moteur, le contexte Docker, le client ou les droits. Sous Windows, démarrez Docker Desktop avec les conteneurs Linux. Sous Linux, faites vérifier l’accès au socket par l’administrateur, sans le rendre accessible à tout le monde.

Pour un hôte distant, vérifiez l’adresse, le port SSH, l’utilisateur et la méthode d’authentification configurés. Sur cet hôte, Docker CLI, Docker Compose, `timeout` et les droits d’accès au moteur doivent être disponibles. Ne partagez pas de clé privée pour demander de l’aide.

Si une modification échoue, lisez le message et l’aperçu avant de la relancer. Vérifiez les sauvegardes disponibles et évitez d’appliquer plusieurs fois la même action sans connaître son résultat.

## Le travail a disparu ou un export ne s’ouvre pas

- **Atelier navigateur :** les données restent dans la mémoire de l’onglet. Après sa fermeture ou un rechargement, un travail non exporté peut être perdu. Vérifiez vos téléchargements et réimportez le dernier Compose exporté.
- **Application locale :** les projets restent dans `data/`, à côté du lanceur. Vérifiez que vous avez rouvert le même dossier de l’application. Ne remplacez pas ce dossier par celui d’une extraction vide.
- **Export Compose :** le YAML ne contient pas les données des volumes, les images construites localement ni tous les fichiers externes. Un déploiement peut encore demander ces éléments et des variables d’environnement.
- **Téléchargement introuvable :** consultez l’historique des téléchargements de votre navigateur et son éventuel message de blocage.

## Demander de l’aide

Si le problème persiste, ouvrez une [issue](https://github.com/caroneloham/docker-tracer/issues) avec ce modèle :

```text
Version ou tag :
Windows/Linux et architecture :
Navigateur et version :
Application locale / atelier en ligne / lancement depuis les sources :
Étapes pour reproduire :
Résultat attendu :
Message exact et résultat observé :
```

Ajoutez seulement l’extrait de journal utile ou un Compose minimal reproduisant le problème. Masquez les clés d’API, mots de passe, adresses privées, données de clients et URLs contenant un jeton d’accès. N’envoyez pas votre dossier d’état complet, votre base de comptes ni vos clés SSH. Pour une vulnérabilité, utilisez le **[signalement privé](https://github.com/caroneloham/docker-tracer/security/advisories/new)** indiqué dans la [politique de sécurité](https://github.com/caroneloham/docker-tracer/blob/main/SECURITY.md).
