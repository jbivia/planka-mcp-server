# planka-mcp-server

Serveur MCP pour une instance [Planka](https://planka.app) 2.x auto-hébergée. Il expose
19 outils qui couvrent le cycle de vie complet d'un ticket — découvrir les tableaux, créer
une carte, la déplacer de colonne en colonne, l'assigner, l'étiqueter, gérer ses tâches et
ses commentaires, l'archiver ou la supprimer.

Sa particularité : **tout se désigne par son nom**. Planka manipule des identifiants
opaques (`1357158568008091264`) et un agent n'a pas à les transporter. Chaque outil accepte
un nom ou un identifiant, résolu en interne à partir d'un cache de la structure du tableau.
Un nom ambigu n'est jamais deviné — l'erreur liste les candidats.

Testé contre l'API Planka **2.2.1** : le cycle complet a été déroulé sur une instance
réelle, des outils de découverte jusqu'à la suppression. Les notes de dépouillement de la
spec OpenAPI, et les points que la spec laisse dans le flou avec ce que l'observation a
tranché, sont dans [`docs/api-notes.md`](docs/api-notes.md).

---

## 1. Créer une clé d'API Planka

Dans Planka : **menu utilisateur → Paramètres → clé d'API**. La clé n'est affichée
qu'une seule fois.

Le compte porteur de la clé doit être **éditeur** (`editor`) des tableaux à modifier :
toutes les écritures de l'API Planka exigent ce rôle, un `viewer` ne peut que lire.

En repli, `PLANKA_EMAIL` + `PLANKA_PASSWORD` fonctionnent aussi : le serveur les échange
contre un jeton au démarrage et le renouvelle quand il expire. Ce repli ne marche pas si
le compte a la double authentification activée.

## 2. Installer

```bash
git clone https://github.com/jbivia/planka-mcp-server.git
cd planka-mcp-server
npm install
npm run build
```

Node 24 ou plus.

## 3. Configurer et tester

Copier `.env.example` en `.env`, remplir `PLANKA_BASE_URL` et `PLANKA_TOKEN`, puis :

```bash
npm run check
```

La commande interroge l'instance et liste les projets et tableaux visibles. Elle sort en
erreur — avec un message qui dit quoi corriger — si l'URL, le jeton ou les droits ne vont pas.

### Variables d'environnement

| Variable | Requis | Rôle |
|---|---|---|
| `PLANKA_BASE_URL` | oui | Racine de l'instance. Le `/api` final est optionnel. |
| `PLANKA_TOKEN` | oui\* | Clé d'API Planka, ou JWT. |
| `PLANKA_EMAIL` | oui\* | Repli : email ou nom d'utilisateur. |
| `PLANKA_PASSWORD` | oui\* | Repli : mot de passe. |
| `PLANKA_TRANSPORT` | non | `stdio` (défaut) ou `http`. |
| `PLANKA_HTTP_HOST` | non | Adresse d'écoute HTTP, défaut `127.0.0.1`. |
| `PLANKA_HTTP_PORT` | non | Port HTTP, défaut `3000`. |
| `PLANKA_HTTP_PATH` | non | Chemin de l'endpoint, défaut `/mcp`. |
| `PLANKA_HTTP_TOKEN` | non | Si défini, les appels HTTP doivent porter ce jeton en bearer. |
| `PLANKA_CACHE_TTL_MS` | non | Durée du cache de structure, défaut `60000`. |

\* Soit `PLANKA_TOKEN`, soit le couple `PLANKA_EMAIL` + `PLANKA_PASSWORD`.

Aucun secret n'est écrit en dur ni journalisé.

## 4. Brancher sur un client MCP

### Claude Code

```bash
claude mcp add planka --scope user \
  --env PLANKA_BASE_URL=https://planka.example.com \
  --env PLANKA_TOKEN=votre_cle \
  -- node /chemin/absolu/vers/planka-mcp-server/dist/index.js
```

### Claude Desktop

Dans `claude_desktop_config.json` :

```json
{
  "mcpServers": {
    "planka": {
      "command": "node",
      "args": ["/chemin/absolu/vers/planka-mcp-server/dist/index.js"],
      "env": {
        "PLANKA_BASE_URL": "https://planka.example.com",
        "PLANKA_TOKEN": "votre_cle"
      }
    }
  }
}
```

### Connecteur distant (HTTP)

Le transport streamable HTTP sert le même serveur derrière un reverse proxy. Il est
**stateful** : chaque client obtient une session identifiée par l'en-tête `Mcp-Session-Id`,
avec sa propre instance de serveur.

```bash
PLANKA_TRANSPORT=http \
PLANKA_HTTP_PORT=3000 \
PLANKA_HTTP_TOKEN=un_secret_long \
npm start
```

Le serveur écoute par défaut sur `127.0.0.1` uniquement. `PLANKA_HTTP_TOKEN` est optionnel
mais recommandé : si le port devient joignable directement, c'est la seule chose entre
Internet et votre jeton Planka. La comparaison est faite à temps constant.

Exemple de reverse proxy (Caddy) :

```caddyfile
mcp-planka.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Côté client, pointer sur `https://mcp-planka.example.com/mcp` avec
`Authorization: Bearer un_secret_long`.

La protection anti-DNS-rebinding du SDK est active : les en-têtes `Host` non attendus sont
refusés. Si le proxy réécrit `Host` en un nom public, ajouter ce nom à `allowedHosts`
dans [`src/transport/http.ts`](src/transport/http.ts).

### Inspecteur MCP

```bash
npm run inspect
```

Ou en ligne de commande :

```bash
npx @modelcontextprotocol/inspector --cli node dist/index.js -e PLANKA_BASE_URL=... -e PLANKA_TOKEN=... --method tools/list
```

---

## Outils exposés

| Outil | Écrit ? | Usage |
|---|---|---|
| `planka_list_projects` | non | Les projets accessibles et leurs tableaux |
| `planka_describe_board` | non | Les listes (dans l'ordre), les labels et les membres d'un tableau |
| `planka_search_cards` | non | Filtrer les cartes par tableau, liste, label, assigné, échéance, texte |
| `planka_get_card` | non | Une carte en détail : description, tâches, commentaires |
| `planka_create_card` | oui | Créer une carte dans une liste |
| `planka_update_card` | oui | Titre, description, échéance |
| `planka_move_card` | oui | **Déplacer une carte** vers une autre liste, à une position choisie |
| `planka_archive_card` | oui | Archiver (réversible) |
| `planka_delete_card` | **destructif** | Supprimer définitivement, avec confirmation par titre |
| `planka_assign_card_member` | oui | Assigner / désassigner un membre |
| `planka_set_card_label` | oui | Ajouter / retirer un label |
| `planka_add_comment` | oui | Commenter |
| `planka_delete_comment` | **destructif** | Supprimer un commentaire, désigné par son identifiant ou son texte |
| `planka_manage_card_tasks` | oui | Ajouter, cocher, décocher ou supprimer une tâche |
| `planka_create_project` | oui | Créer un projet |
| `planka_create_board` | oui | Créer un tableau, avec ses colonnes si on veut |
| `planka_create_list` | oui | Ajouter une colonne à un tableau |
| `planka_create_label` | oui | Définir un label sur un tableau |
| `planka_share_project` | oui | Donner à un autre utilisateur l'accès à un projet ou à ses tableaux |

### Déplacer une carte

C'est l'opération centrale, et la seule où Planka demande quelque chose qu'un agent ne peut
pas deviner : un `position` numérique, obligatoire dès que la liste change, et qui n'a de
sens que par rapport aux cartes déjà présentes.

L'outil accepte donc une intention, pas un nombre :

```jsonc
{ "card": "Fix the login redirect", "list": "En cours" }                   // en bas (défaut)
{ "card": "Fix the login redirect", "list": "En cours", "position": "top" }
{ "card": "…", "list": "En cours", "position": { "after": "Rework auth" } }
{ "card": "…", "list": "En cours", "position": { "index": 2 } }
```

Le calcul se fait sur les positions réelles des voisines lues dans le cache : moitié de la
tête pour passer devant, un pas au-delà de la queue pour passer derrière, moyenne des deux
voisines pour s'intercaler. La réponse confirme le mouvement en clair — liste d'origine,
liste cible, rang final, taille de la liste — pour éviter une relecture.

### Créer une structure

Trois outils créent projets, tableaux et listes. Le cas courant tient en un appel :

```jsonc
{ "project": "Infrastructure", "name": "Roadmap",
  "lists": ["Backlog", "En cours", "Terminé"] }
```

Sans `lists`, le tableau n'a que les listes système `archive` et `trash` de Planka : aucune
colonne, donc `planka_create_card` y échouerait. La réponse le dit explicitement plutôt que
de laisser l'agent le découvrir.

Même chose pour les labels, avec un piège en plus : un tableau créé **par l'API** n'en a
aucun, là où l'interface Planka en pose une série au départ. `planka_set_card_label` ne sait
qu'appliquer un label existant — sur un tableau créé par le serveur, il n'y avait donc rien à
appliquer. D'où `labels` sur `planka_create_board`, et `planka_create_label` pour en ajouter
un après coup :

```jsonc
{ "project": "Infrastructure", "name": "Roadmap",
  "lists": ["Backlog", "En cours", "Terminé"], "labels": ["bug", "urgent"] }
```

La couleur est facultative : par défaut le serveur prend la première des 42 couleurs Planka
que le tableau n'utilise pas encore. Deux labels de la même couleur sont indiscernables sur
une carte, qui est le seul endroit où on les lit.

`POST /projects/{id}/boards` est le seul endpoint de l'API en `multipart/form-data` — il
sert aussi à l'import Trello — d'où le mode formulaire du client HTTP.

### Partager ce que le serveur crée

Si le serveur tourne sous son propre compte Planka — un compte `claude` distinct du vôtre —
tout ce qu'il crée n'appartient qu'à lui : `POST /projects` fait de l'appelant l'unique chef
de projet, `POST /projects/{id}/boards` l'unique membre du tableau. Vous ne voyez rien depuis
votre compte, même administrateur.

`planka_share_project` corrige ça. Planka offre deux leviers **qui ne se valent pas** :

| `role` | Route | Donne | Marche sur un projet perso ? |
|---|---|---|---|
| `editor` (défaut) | `POST /boards/{id}/board-memberships` | Les tableaux du projet, en écriture | **oui** |
| `viewer` | idem, `role: viewer` | Les mêmes en lecture seule (`can_comment` pour autoriser les commentaires) | **oui** |
| `manager` | `POST /projects/{id}/project-managers` | Le projet entier, tableaux présents et futurs | **non — 403** |

Un projet créé avec `visibility: "private"` est un projet *personnel* : Planka lui interdit
un second chef de projet, définitivement. Vérifié sur 2.2.1, le refus est un
`403 "Not enough rights"` que l'outil réécrit en nommant les deux issues. D'où le défaut
`editor` : le partage par tableau, lui, fonctionne partout, y compris sur les projets
personnels déjà créés.

```jsonc
// tout le projet, en écriture
{ "project": "Infrastructure", "user": "jerome" }
// un seul tableau, en lecture
{ "project": "Infrastructure", "user": "jerome", "role": "viewer", "boards": ["Roadmap"] }
```

Deux conséquences à connaître :

- **Chef de projet ≠ assignable.** Seuls les membres d'un tableau peuvent recevoir une carte.
  Quelqu'un qui doit prendre des cartes a besoin d'un partage `editor`, même s'il est déjà
  manager.
- **`visibility` ne se change pas après coup.** Le champ `type` n'est ni renvoyé en lecture
  ni accepté par `PATCH /projects/{id}`. Pour qu'un projet soit administrable à plusieurs, il
  faut le créer en `shared` dès le départ.

Résoudre un destinataire par nom, pseudo ou email passe par `GET /users`, qui exige le rôle
`admin` ou `projectOwner`. Un compte qui ne l'a pas peut quand même partager en passant
l'identifiant Planka de la personne : il est lu directement, sans le listing.

L'appel est idempotent : un `409` (« déjà membre ») est rapporté comme tel, pas comme une
erreur.

### Économie de contexte

Les réponses Planka contiennent de gros blocs `included` : des tables de jointure brutes
qu'il faudrait recoller soi-même. Rien n'est relayé tel quel.

- Les jointures sont résolues côté serveur : les labels et les assignés reviennent en
  **noms**, pas en identifiants.
- `planka_search_cards` pagine (`limit` / `offset`, défaut 25) et rend une ligne par carte.
- `planka_get_card` a deux niveaux : `summary` (l'état de la carte) et `full` (description,
  toutes les tâches, les commentaires récents).
- Toutes les lectures acceptent `response_format: "markdown" | "json"`.
- Un plafond dur de 25 000 caractères tronque avec une note plutôt que de saturer le contexte.

### Erreurs

Un message d'erreur dit quoi faire ensuite. Une liste introuvable ne renvoie pas `404` mais :

```
Error: List "Terminé" not found on board "Roadmap". Available: "Backlog", "En cours", "Done".
Call planka_describe_board to see the lists of this board.
```

Un nom ambigu n'est jamais tranché au hasard :

```
Error: List "Review" is ambiguous on board "Roadmap": it matches "Review — backend", "Review — frontend".
Use the exact name, or the id of the one you mean.
```

### Garde-fous

- `planka_delete_card` est annoté `destructiveHint: true` et exige `confirm_name`, le titre
  exact de la carte recopié. La carte est lue avant, ce qui valide aussi l'identifiant.
- `planka_delete_comment` est lui aussi `destructiveHint: true`. Le commentaire est cherché
  sur la carte désignée avant toute suppression : un identifiant venu d'une autre carte, ou
  un texte partagé par deux commentaires, échoue sans rien effacer. Planka ne laisse
  supprimer un commentaire qu'à son auteur ou à un chef du projet.
- `planka_archive_card` est préféré partout : Planka retient la liste d'origine
  (`prevListId`), l'archivage est donc réversible depuis l'interface.
- Les listes système (`archive`, `trash`) ne sont pas proposées comme cibles de
  `planka_move_card` : un agent ne doit pas archiver une carte en croyant la classer.
- Le serveur crée projets, tableaux et listes, mais n'en supprime **aucun** : une
  structure créée par erreur se nettoie dans l'interface Planka. Les trois outils de
  création refusent un nom déjà pris et nomment l'existant — Planka accepterait deux
  tableaux « Roadmap » dans un projet, ce qui rendrait les deux inatteignables par nom.
- `planka_share_project` n'enlève aucun accès : il ne sait qu'ajouter. Retirer un membre ou
  un chef de projet se fait dans l'interface Planka.
- Créer un label est un outil à part, jamais un effet de bord de `planka_set_card_label` :
  un agent qui en crée à la volée pour poser un tag transforme une taxonomie en broussaille
  en quelques sessions. Il refuse un nom déjà pris, comme les autres outils de création, et
  sa description invite à réutiliser ce que `planka_describe_board` liste.

---

## Architecture

```
src/
├── index.ts              entrée, CLI (--check / --help), choix du transport
├── constants.ts          noms d'env, budgets, TTL, pas de position
├── config.ts             lecture et validation de l'environnement
├── errors.ts             PlankaError (message + hint) et rendu
├── types.ts              types miroir de l'API Planka + formes projetées
├── transport/
│   └── http.ts           node:http + streamable HTTP stateful + bearer optionnel
├── services/
│   ├── client.ts         client HTTP unique, mapping d'erreurs centralisé
│   ├── auth.ts           clé d'API vs JWT, échange identifiants, renouvellement
│   ├── board-cache.ts    snapshot de tableau avec TTL et invalidation
│   ├── resolve.ts        résolution nom/identifiant, erreurs avec candidats
│   ├── position.ts       arithmétique de position (top/bottom/before/after/index)
│   ├── project.ts        projections : included -> formes exposées
│   ├── card.ts           localisation d'une carte, avec ou sans tableau
│   └── format.ts         toolSuccess/toolFailure, pagination, markdown
├── schemas/common.ts     shapes Zod partagées
└── tools/                discovery, read, lifecycle, attributes, structure
```

Points de conception notables :

- **Un seul appel par tableau.** `GET /boards/{id}` renvoie listes, labels, membres, cartes
  et tâches d'un coup. Ce snapshot alimente la résolution de noms, la description, la
  recherche et le calcul de position — déplacer une carte coûte 1 GET (souvent 0, en cache)
  + 1 PATCH, contre trois appels avec l'API brute.
- **Invalidation sur succès seulement.** Une écriture qui échoue laisse le cache intact : la
  photo du tableau est toujours juste, la jeter ne coûterait qu'un rechargement.
- **Résolution stricte d'abord.** Égalité exacte, puis préfixe, puis sous-chaîne ; la
  première passe qui donne un seul résultat gagne. Avec des listes « Done » et « Not Done »,
  « Done » résout proprement au lieu d'être signalé ambigu.
- **Les tâches suivent le modèle 2.x.** Une carte porte des *task lists*, qui portent les
  tâches. Une carte créée par l'API n'en a aucune, donc la première tâche ajoutée crée aussi
  sa liste.
- **Les échecs d'outil sont renvoyés en bande** (`isError: true` avec le message), pour que
  l'agent puisse lire le conseil et réessayer autrement.

## Développer

```bash
npm run dev      # tsx watch
npm test         # node:test, fetch mocké, aucun appel réseau
npm run build
```

Les tests couvrent le calcul de position, la résolution de noms, la projection des réponses
et le mapping des erreurs HTTP.

## Licence

MIT — voir [LICENSE](LICENSE).
