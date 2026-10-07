# planka-mcp-server

Serveur [MCP](https://modelcontextprotocol.io) qui donne à un agent (Claude Code, Claude
Desktop ou tout client MCP) la main sur une instance [Planka](https://planka.app) 2.x
auto-hébergée : explorer les tableaux, créer et faire avancer des cartes, gérer leurs
tâches, labels, membres et commentaires, monter des projets et les partager.

**Tout se désigne par son nom.** L'agent écrit « déplace *Corriger la connexion* dans
*En cours* » ; le serveur retrouve les identifiants Planka. Un nom ambigu n'est jamais
deviné : l'erreur liste les candidats.

Testé contre Planka 2.2.1. Node 24 ou plus.

## Démarrage rapide

**1. Créer une clé d'API Planka** — menu utilisateur → *Paramètres* → *Clé d'API*. Elle
n'est affichée qu'une fois. Le compte doit être **éditeur** des tableaux à modifier : un
`viewer` ne peut que lire.

**2. Installer**

```bash
git clone https://github.com/jbivia/planka-mcp-server.git
cd planka-mcp-server
npm install && npm run build
```

**3. Vérifier** — copier `.env.example` en `.env`, renseigner `PLANKA_BASE_URL` et
`PLANKA_TOKEN`, puis :

```bash
npm run check
```

La commande liste les projets et tableaux visibles, ou dit précisément ce qui ne va pas
(URL, clé, droits). Le fichier `.env` ne sert qu'à cette vérification : en usage normal,
c'est le client MCP qui transmet les variables.

**4. Brancher sur un client MCP**

Claude Code :

```bash
claude mcp add planka --scope user \
  --env PLANKA_BASE_URL=https://planka.example.com \
  --env PLANKA_TOKEN=votre_cle \
  -- node /chemin/absolu/vers/planka-mcp-server/dist/index.js
```

Claude Desktop, dans `claude_desktop_config.json` :

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

Il suffit ensuite de parler à l'agent :

- « Quels tableaux j'ai sur Infrastructure ? »
- « Crée un tableau Roadmap avec les colonnes Backlog, En cours et Terminé. »
- « Ajoute *Renouveler le certificat TLS* dans Backlog, assigne-la à Jane, label urgent. »
- « Passe-la en haut de En cours. » — « Quelles cartes de jdoe sont en retard ? »

## Fonctionnalités

19 outils, tous préfixés `planka_`.

| Domaine | Outils | Ce qu'ils font |
|---|---|---|
| Découvrir | `list_projects`, `describe_board`, `search_cards` | Projets et tableaux visibles ; listes, labels et membres d'un tableau ; recherche de cartes par liste, label, assigné, échéance (dont en retard) ou texte |
| Lire | `get_card` | Une carte complète : description, tâches, commentaires récents |
| Cartes | `create_card`, `update_card`, `move_card`, `archive_card`, `delete_card` | Créer, modifier (titre, description, échéance), déplacer à une position choisie, archiver, supprimer |
| Contenu d'une carte | `assign_card_member`, `set_card_label`, `manage_card_tasks`, `add_comment`, `delete_comment` | Assigner, étiqueter, ajouter/cocher/supprimer des tâches, commenter |
| Structure | `create_project`, `create_board`, `create_list`, `create_label` | Monter un projet, un tableau avec ses colonnes et ses labels, ajouter une colonne ou un label |
| Partage | `share_project` | Donner accès à un projet ou à certains de ses tableaux |

Les lectures acceptent `response_format: "markdown"` (défaut, compact) ou `"json"`. Les
résultats sont résumés et paginés pour ménager le contexte de l'agent.

## Bon à savoir

**Désigner les choses.** Chaque argument accepte un nom ou un identifiant. La recherche
essaie l'égalité exacte, puis le préfixe, puis la sous-chaîne. Préciser `board` (et
`project` si deux projets ont un tableau du même nom) évite toute ambiguïté ; sans
tableau, une carte doit être désignée par son titre exact ou son identifiant.

**Placer une carte.** On donne une intention, le serveur calcule la position Planka :

```jsonc
{ "card": "Corriger la connexion", "list": "En cours" }                      // en bas (défaut)
{ "card": "Corriger la connexion", "list": "En cours", "position": "top" }
{ "card": "…", "list": "En cours", "position": { "after": "Refonte auth" } }   // ou "before"
{ "card": "…", "list": "En cours", "position": { "index": 2 } }               // rang, à partir de 0
```

**Écrire de longs textes.** Une description peut atteindre 1 048 576 caractères (un
chapitre, une spécification). Pour ne pas renvoyer tout le texte à chaque modification,
`planka_update_card` propose trois modes, un par appel :

```jsonc
{ "card": "Chapitre 3", "description": "…" }                      // remplace tout
{ "card": "Chapitre 3", "append_description": "## Scène 2\n\n…" }  // ajoute un paragraphe à la fin
{ "card": "Chapitre 3",
  "description_edits": [{ "find": "Marie regardait", "replace": "Jeanne observait" }] }
```

Chaque `find` doit apparaître une seule fois, sinon rien n'est modifié. À la lecture,
`planka_get_card` découpe une longue description en pages : la réponse indique le
`description_offset` à passer pour lire la suite. Pour un travail d'écriture à un seul
rédacteur, `PLANKA_CACHE_TTL_MS=600000` évite de relire le tableau entre deux appels.

**Créer un tableau utilisable d'un coup.** Un tableau créé par l'API n'a ni colonne ni
label (contrairement à l'interface Planka) :

```jsonc
{ "project": "Infrastructure", "name": "Roadmap",
  "lists": ["Backlog", "En cours", "Terminé"], "labels": ["bug", "urgent"] }
```

Les labels reçoivent chacun une couleur distincte. Projets, tableaux, listes et labels
refusent un nom déjà pris, pour que tout reste désignable par son nom.

**Partager.** Si le serveur utilise son propre compte Planka, ce qu'il crée n'est visible
que de lui. `planka_share_project` ouvre l'accès :

| `role` | Donne | Remarque |
|---|---|---|
| `editor` (défaut) | Les tableaux du projet, en écriture | Fonctionne partout |
| `viewer` | Les mêmes en lecture (`can_comment` pour commenter) | Fonctionne partout |
| `manager` | L'administration du projet, tous ses tableaux | Refusé sur un projet créé en `visibility: "private"` |

Seuls les membres d'un tableau peuvent être assignés à ses cartes : un manager qui doit
prendre des cartes a aussi besoin d'un partage `editor`. Désigner la personne par son nom
ou son email demande que le compte du serveur soit `admin` ou `projectOwner` ; sinon,
passer son identifiant Planka.

**Garde-fous.**
- `planka_delete_card` exige `confirm_name`, le titre exact de la carte. Préférer
  `planka_archive_card`, réversible depuis l'interface Planka.
- `planka_delete_comment` vérifie que le commentaire est bien sur la carte indiquée.
  Planka ne laisse supprimer un commentaire qu'à son auteur ou à un chef de projet.
- Le serveur ne supprime ni projet, ni tableau, ni liste, ni label, et ne retire aucun
  accès : ces nettoyages se font dans l'interface Planka.
- Les listes système (archive, corbeille) ne sont jamais proposées comme destination d'un
  déplacement.

## Configuration

| Variable | Défaut | Rôle |
|---|---|---|
| `PLANKA_BASE_URL` | — (requis) | Adresse de l'instance ; le `/api` final est facultatif |
| `PLANKA_TOKEN` | — | Clé d'API Planka (ou JWT) |
| `PLANKA_EMAIL`, `PLANKA_PASSWORD` | — | À la place de la clé : identifiants échangés contre un jeton, renouvelé automatiquement. Incompatible avec la double authentification |
| `PLANKA_CACHE_TTL_MS` | `60000` | Durée du cache de structure des tableaux |
| `PLANKA_TRANSPORT` | `stdio` | `http` pour un connecteur distant |
| `PLANKA_HTTP_HOST`, `PLANKA_HTTP_PORT`, `PLANKA_HTTP_PATH` | `127.0.0.1`, `3000`, `/mcp` | Adresse, port et chemin d'écoute HTTP |
| `PLANKA_HTTP_TOKEN` | — | Jeton bearer exigé des clients HTTP (recommandé) |
| `PLANKA_HTTP_ALLOWED_HOSTS` | — | Noms publics acceptés dans l'en-tête `Host`, séparés par des virgules |

Il faut soit `PLANKA_TOKEN`, soit le couple email + mot de passe. Aucun secret n'est
journalisé. `node dist/index.js --help` résume ces variables.

### Connecteur distant (HTTP)

```bash
PLANKA_TRANSPORT=http \
PLANKA_HTTP_TOKEN=un_secret_long \
PLANKA_HTTP_ALLOWED_HOSTS=mcp-planka.example.com \
PLANKA_BASE_URL=https://planka.example.com PLANKA_TOKEN=votre_cle \
npm start
```

Derrière un reverse proxy, par exemple Caddy :

```caddyfile
mcp-planka.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Le client se connecte à `https://mcp-planka.example.com/mcp` avec
`Authorization: Bearer un_secret_long`. Le nom public doit figurer dans
`PLANKA_HTTP_ALLOWED_HOSTS` : la protection anti-DNS-rebinding refuse tout autre `Host`.
Une session inactive depuis 30 minutes est fermée ; le client en ouvre alors une nouvelle.

## Dépannage

| Symptôme | Piste |
|---|---|
| `401` | Clé ou identifiants invalides. Une clé d'API se recrée dans Planka, elle n'est montrée qu'une fois |
| `403` sur une écriture | Le compte est `viewer` du tableau ; il doit être `editor` |
| Échec de connexion par email | Double authentification active : utiliser une clé d'API |
| Certificat refusé | CA privée : `NODE_EXTRA_CA_CERTS=/chemin/vers/ca.pem` |
| `403` en HTTP derrière un proxy | Ajouter le nom public à `PLANKA_HTTP_ALLOWED_HOSTS` |
| Carte introuvable sans `board` | Seuls les 10 premiers tableaux sont parcourus : préciser `board` ou `project` |

Pour explorer les outils à la main : `npm run inspect` (inspecteur MCP).

## Développer

```bash
npm run dev     # rechargement à chaud
npm test        # tests hors réseau (fetch simulé)
npm run build
```

Le code est dans `src/` : `tools/` pour les outils, `services/` pour le client HTTP, le
cache des tableaux, la résolution des noms et le calcul des positions. Le comportement de
l'API Planka, y compris ce que sa documentation ne dit pas, est consigné dans
[`docs/api-notes.md`](docs/api-notes.md).

## Licence

MIT — voir [LICENSE](LICENSE).
