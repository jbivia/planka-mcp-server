# Politique de sécurité

## Signaler une vulnérabilité

**N'ouvrez pas d'issue publique pour une vulnérabilité.** Utilisez le signalement
privé de GitHub : onglet **Security** du dépôt → **Report a vulnerability**.

Vous recevrez un accusé de réception sous 7 jours. Ce projet est maintenu sur du
temps libre : merci de prévoir un délai raisonnable avant toute divulgation
publique.

## Versions supportées

Seule la dernière version publiée reçoit des correctifs.

## Périmètre

Ce serveur est un intermédiaire entre un client MCP et une instance Planka. Les
points sensibles, par ordre d'impact :

| Sujet | Ce qui compte |
| --- | --- |
| Manipulation d'identifiants | Une clé d'API Planka ou un JWT qui fuiterait dans un journal, un message d'erreur ou une réponse d'outil |
| Transport HTTP | Contournement de `PLANKA_HTTP_TOKEN`, oracle temporel sur sa comparaison, contournement de la protection anti-DNS-rebinding, fixation de session |
| Isolation des sessions | Une session HTTP qui verrait l'état d'une autre |
| Injection de chemin | Une valeur d'argument qui s'échapperait du chemin d'API auquel elle est destinée |
| Chaîne d'approvisionnement | Dépendance compromise, workflow CI exploitable |

### Hors périmètre

- **Les vulnérabilités de Planka lui-même.** À signaler au
  [projet Planka](https://github.com/plankanban/planka). Ce serveur n'accorde
  aucun droit que le compte porteur de la clé n'a pas déjà.
- **Le fait qu'un agent puisse supprimer une carte.** C'est la fonction de
  `planka_delete_card`. Elle est annotée `destructiveHint` et exige que le titre
  exact soit recopié ; le contrôle final appartient au client MCP et à
  l'utilisateur.
- **Un compte Planka sur-privilégié.** Le cloisonnement se décide dans Planka,
  par le rôle du compte de service. Donnez-lui l'accès aux seuls projets utiles.

## Bonnes pratiques de déploiement

- Un **compte de service dédié** dans Planka, membre des seuls projets
  nécessaires, plutôt que votre compte d'administration.
- Une **clé d'API** plutôt que `PLANKA_EMAIL` + `PLANKA_PASSWORD` : le mot de
  passe donne accès à tout le compte, la clé est révocable seule.
- En transport HTTP : garder l'écoute sur `127.0.0.1`, définir
  `PLANKA_HTTP_TOKEN`, et placer un reverse proxy en TLS devant.
- Ne jamais mettre d'identifiants dans le dépôt. `.env` est ignoré par git ;
  gardez-le ainsi.
