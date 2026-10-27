# Politique de sécurité

## Signaler une vulnérabilité en privé

Utilisez **[Report a vulnerability](https://github.com/caroneloham/docker-tracer/security/advisories/new)** dans l’onglet Security du dépôt. Ce canal transmet votre rapport de façon privée aux responsables du projet.

Ne publiez pas de preuve d’exploitation, de clé, de mot de passe ou de données privées dans une issue ou une pull request publique. Pour un bug sans conséquence de sécurité, vous pouvez utiliser les [issues](https://github.com/caroneloham/docker-tracer/issues).

## Informations utiles

- Version ou commit concerné, système utilisé et mode d’exécution.
- Étapes minimales de reproduction sur un environnement de test.
- Comportement observé, résultat attendu et impact concret.
- Exemple ou capture expurgé de tout secret, donnée de client ou adresse privée.

Le projet est en bêta. Indiquez si le problème se reproduit avec la dernière version publiée ; les signalements concernant une ancienne version restent utiles. Aucun délai de réponse ou de correction n’est garanti.

## Périmètre

Cette politique couvre l’application locale Docker Tracer, ses lanceurs Windows/Linux, ses API et l’atelier Compose utilisable dans le navigateur.

Les éléments sensibles comprennent les sessions locales, accès Docker/SSH, fichiers et journaux de projets. L’application locale dispose de fonctions d’administration ; l’atelier navigateur manipule le Compose dans l’onglet.

## Propriétés de sécurité attendues

- Le jeton du lien de démarrage ne doit pas pouvoir être réutilisé comme cookie de session ; le lien d’activation doit rester à usage unique.
- Les opérations locales sensibles doivent exiger la session prévue et respecter les protections d’origine applicables.
- Les noms et contenus Compose doivent être traités comme des données non fiables, sans modifier les prototypes JavaScript ni permettre une exécution inattendue.
- Les accès aux fichiers et les archives doivent respecter les répertoires autorisés.
- L’atelier navigateur ne doit pas activer les API du serveur local, exécuter de commande ni transmettre le Compose importé à un moteur Docker.

Ces propriétés décrivent les limites à préserver ; elles ne constituent pas une attestation qu’un audit a validé tous les parcours. Un contournement reproductible avec un impact sur la confidentialité, l’intégrité ou la disponibilité doit être signalé, y compris lorsqu’il concerne une dépendance.

## Précautions et limites

Le terminal, les fichiers et les fonctions Docker de l’application locale disposent des droits du processus qui l’exécute. Le serveur local est conçu pour `127.0.0.1` : ne publiez pas son port ni son API sur Internet. Vérifiez les aperçus et vos sauvegardes avant de modifier une infrastructure.

Reproduisez les problèmes sur vos propres environnements de test, sans accéder aux données d’autrui ni perturber le service public. L’absence d’alerte automatique ne garantit pas l’absence de vulnérabilité.
