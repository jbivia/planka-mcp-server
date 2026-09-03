# Notes d'API Planka 2.x

Source unique de vérité : le `/swagger.json` exposé par l'instance elle-même,
récupéré le 2026-09-03. En-tête de la spec :

```
openapi: 3.0.0
info.version: 2.2.1
info.title: PLANKA API
servers[0].url: /api
```

Ce document est le dépouillement de cette spec, écrit **avant** toute ligne de code.
Il n'utilise aucun souvenir de l'API 1.x — et ce n'est pas une précaution de style : la
différence la plus structurante est justement là, sur les tâches (voir « Pièges 1.x →
2.x »).

---

## 1. Authentification

Deux schémas de sécurité déclarés, alternatifs (`security` est une liste de deux
entrées à un élément, donc l'un **ou** l'autre suffit) :

| Schéma | Transport | Obtention |
|---|---|---|
| `bearerAuth` | `Authorization: Bearer <jwt>` | `POST /api/access-tokens` |
| `apiKeyAuth` | `X-Api-Key: <clé>` | `POST /api/users/{id}/api-key` |

**Échange identifiants → JWT.**

```
POST /api/access-tokens
{ "emailOrUsername": "…", "password": "…", "withHttpOnlyToken": false }
→ 200 { "item": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ4…" }
```

`emailOrUsername` et `password` sont requis, `maxLength: 256` chacun. Réponses
d'erreur : 400, 401, 403. Si le compte a la 2FA active, le flux passe par
`POST /api/access-tokens/verify-totp` — **non couvert par ce serveur MCP** : un compte
de service ne doit pas avoir de TOTP.

**Clé d'API.** `POST /api/users/{id}/api-key` (corps vide) renvoie
`{ item: User, included: { apiKey: "<la clé, en clair, une seule fois>" } }`.
La spec est explicite : *« The full API key is returned only once and cannot be
retrieved again. »* Le champ `User.apiKeyPrefix` permet ensuite de savoir qu'une clé
existe, sans la révéler.

**Conséquence pour le serveur MCP.** `PLANKA_TOKEN` peut être l'un ou l'autre. On
discrimine sur la forme : un JWT est fait de trois segments base64url séparés par des
points (`/^[\w-]+\.[\w-]+\.[\w-]+$/`) → `Authorization: Bearer` ; tout le reste →
`X-Api-Key`. Un JWT finit par expirer, une clé d'API non — d'où le repli
`PLANKA_EMAIL` + `PLANKA_PASSWORD` qui permet de re-signer sur 401.

---

## 2. Modèle de données

```
Project
 └─ Board                      (Board.projectId)
     ├─ List                   (List.boardId)      type: active | closed | archive | trash
     │   └─ Card               (Card.listId, Card.boardId)
     │       ├─ TaskList       (TaskList.cardId)
     │       │   └─ Task       (Task.taskListId)
     │       ├─ Comment        (Comment.cardId, Comment.userId)
     │       ├─ CardLabel      (cardId × labelId)   ← table de jointure
     │       ├─ CardMembership (cardId × userId)    ← table de jointure
     │       └─ Attachment
     ├─ Label                  (Label.boardId)
     └─ BoardMembership        (boardId × userId, role: editor | viewer)
```

Les **IDs sont des chaînes** de chiffres façon snowflake (`"1357158568008091264"`),
jamais des entiers JSON. À traiter comme opaques, mais leur forme purement numérique
est exploitable comme heuristique « est-ce un ID ou un nom ? ».

### Champs réellement disponibles

**`Project`** — `id`, `name`, `description?`, `ownerProjectManagerId?`,
`backgroundType? (gradient|image)`, `backgroundGradient?`, `backgroundImageId?`,
`isHidden`, `createdAt?`, `updatedAt?`. Sur `GET /projects` s'ajoute `isFavorite`.
Pas de champ `slug`, pas d'URL canonique exposée.

**`Board`** — `id`, `projectId`, `position`, `name`,
`defaultView (kanban|grid|list)`, `defaultCardType (project|story)`,
`limitCardTypesToDefaultOne`, `alwaysDisplayCardCreator`, `displayCardAges`,
`expandTaskListsByDefault`, timestamps. `defaultCardType` est utile : c'est le défaut
à appliquer au `type` requis à la création d'une carte.

**`List`** — `id`, `boardId`, `type (active|closed|archive|trash)`, `position?`,
`name?`, `color?`, timestamps. `name` et `position` sont nullables parce que les listes
système (`archive`, `trash`) n'en ont pas. Couleurs : `berry-red`, `pumpkin-orange`,
`lagoon-blue`, `pink-tulip`, `light-mud`, `orange-peel`, `bright-moss`, `antique-blue`,
`dark-granite`, `turquoise-sea`.

**`Card`** — `id`, `boardId`, `listId`, `creatorUserId?`, `prevListId?`,
`coverAttachmentId?`, `type (project|story)`, `position?`, `name`, `description?`,
`dueDate?`, `isDueCompleted?`, `stopwatch?`, `commentsTotal`, `isClosed`,
`listChangedAt?`, timestamps. Sur les routes de lecture s'ajoute `isSubscribed`.

Deux champs méritent d'être soulignés :
- `prevListId` — *« ID of the previous list the card was in (available when in archive
  or trash) »*. C'est la preuve que l'archivage est un déplacement de liste, et que
  Planka mémorise d'où la carte vient pour pouvoir la restaurer.
- `commentsTotal` — compteur dénormalisé, évite un appel pour afficher « 3 commentaires ».

Les assignés et les labels **ne sont pas sur la carte** : ils vivent dans
`cardMemberships` et `cardLabels`, livrés dans le bloc `included`.

**`Label`** — `id`, `boardId`, `position`, `name?`, `color`, timestamps. Le nom est
nullable : un label peut n'être qu'une couleur. 42 couleurs possibles (`muddy-grey`,
`autumn-leafs`, `morning-sky`, `antique-blue`, `egg-yellow`, … `pirate-gold`).

**`TaskList`** — `id`, `cardId`, `position`, `name`, `showOnFrontOfCard`,
`hideCompletedTasks`, timestamps.

**`Task`** — `id`, `taskListId`, `linkedCardId?`, `assigneeUserId?`, `position`,
`name`, `isCompleted`, timestamps. Une tâche peut donc être *soit* du texte libre,
*soit* un lien vers une autre carte (`linkedCardId`), auquel cas `name` est facultatif.

**`Comment`** — `id`, `cardId`, `userId?`, `text`, timestamps.

**`BoardMembership`** — `id`, `projectId`, `boardId`, `userId`,
`role (editor|viewer)`, `canComment?`, timestamps. C'est ce qui définit qui est
assignable sur une carte du board.

**`User`** — `id`, `name`, `username?`, `email`, `role (admin|projectOwner|boardUser)`,
`avatar?`, `isDeactivated`, plus une longue traîne de préférences UI sans intérêt ici.
Trois champs servent à résoudre un membre par son nom : `name`, `username`, `email`.

### Forme des réponses

Uniforme et systématique :

```jsonc
// route « un objet »
{ "item": {…}, "included": { "users": [], "cardLabels": [], … } }

// route « une collection »
{ "items": [{…}], "included": { … } }
```

`included` est une **base relationnelle mise à plat** : des tableaux d'entités liées,
à recoller soi-même par ID. C'est puissant (`GET /boards/{id}` renvoie le board entier
en un appel) et c'est exactement ce que la spec MCP interdit de relayer tel quel.

---

## 3. Routes par opération du cycle de vie

Toutes préfixées `/api`.

### Découverte

| Opération | Route | Notes |
|---|---|---|
| Projets accessibles | `GET /projects` | `items: Project[]`, `included`: `boards`, `boardMemberships`, `users`, `projectManagers`, `backgroundImages`, `baseCustomFieldGroups`, `customFields`, `notificationServices`. **Un seul appel donne projets + tableaux.** Aucun paramètre de requête, aucune pagination. |
| Détail projet | `GET /projects/{id}` | `included` sans les cartes : `boards`, `boardMemberships`, `users`, … |
| **Détail tableau** | `GET /boards/{id}` | La route pivot. `included`: `lists`, `labels`, `cards`, `cardLabels`, `cardMemberships`, `taskLists`, `tasks`, `attachments`, `boardMemberships`, `users`, `projects`, `customField*`. Paramètre `subscribe` — sockets uniquement, sans effet en HTTP. |
| Détail liste | `GET /lists/{id}` | Rarement utile, le board suffit. |

### Recherche

| Route | Paramètres |
|---|---|
| `GET /lists/{listId}/cards` | `search` (texte), `labelIds` (CSV), `userIds` (CSV — *« filter by members or task assignees »*), curseur `before[listChangedAt]` **+** `before[id]` (les deux ensemble) |

**Il n'existe aucune route de recherche globale**, ni au niveau board, ni au niveau
projet, ni au niveau instance. Et celle-ci est restreinte : *« must be an endless
list »* (voir Zone d'ombre nº 1). La recherche transverse est donc à la charge du
serveur MCP, à partir des snapshots de `GET /boards/{id}`.

### Lecture d'une carte

| Opération | Route |
|---|---|
| Détail carte | `GET /cards/{id}` — `included`: `users`, `cardMemberships`, `cardLabels`, `taskLists`, `tasks`, `attachments`, `customField*` |
| Commentaires | `GET /cards/{cardId}/comments` — pagination par `beforeId` |

Noter que `GET /cards/{id}` **ne renvoie pas les commentaires** ni les labels du board
(seulement les jointures `cardLabels`, qui donnent des `labelId` sans leur nom ni leur
couleur). Un affichage complet de carte = 2 appels + le snapshot du board pour
traduire les `labelId`.

### Cycle de vie

| Opération | Route | Corps |
|---|---|---|
| Créer une carte | `POST /lists/{listId}/cards` | requis `type` (`project`\|`story`), `name` ; optionnels `position`, `description`, `dueDate`, `isDueCompleted`, `stopwatch` |
| Mettre à jour | `PATCH /cards/{id}` | tous optionnels : `name`, `description`, `dueDate`, `isDueCompleted`, `type`, `coverAttachmentId`, `isSubscribed` |
| **Déplacer** | `PATCH /cards/{id}` | `listId` + `position` — la spec précise sur `position` : *« required when moving card to new list »*. `boardId` permet même de changer de tableau. |
| Archiver | `PATCH /cards/{id}` | `{ listId: <id de la liste type=archive du board> }` + `position`. Pas de route dédiée. |
| Supprimer | `DELETE /cards/{id}` | *« Deletes a card and all its contents (tasks, attachments, etc.) »* → `{ item: Card }` |
| Assigner | `POST /cards/{cardId}/card-memberships` | `{ userId }` |
| Désassigner | `DELETE /cards/{cardId}/card-memberships/userId:{userId}` | — |
| Ajouter un label | `POST /cards/{cardId}/card-labels` | `{ labelId }` |
| Retirer un label | `DELETE /cards/{cardId}/card-labels/labelId:{labelId}` | — |
| Commenter | `POST /cards/{cardId}/comments` | `{ text }` |
| Créer une task list | `POST /cards/{cardId}/task-lists` | requis `position`, `name` ; optionnels `showOnFrontOfCard`, `hideCompletedTasks` |
| Ajouter une tâche | `POST /task-lists/{taskListId}/tasks` | requis `position` ; `name` *« required if linkedCardId is not provided »* ; optionnels `linkedCardId`, `isCompleted` |
| Cocher / décocher | `PATCH /tasks/{id}` | `{ isCompleted: true \| false }` ; aussi `name`, `position`, `taskListId`, `assigneeUserId` |
| Supprimer une tâche | `DELETE /tasks/{id}` | — |

Les deux routes de suppression de jointure ont une forme inhabituelle : le
discriminant est un **segment de chemin préfixé**, `…/card-labels/labelId:{labelId}`
et `…/card-memberships/userId:{userId}`, et non un ID de jointure. C'est une bonne
nouvelle — on n'a pas besoin de connaître l'ID du `CardLabel`, seulement celui du
label. Le `:` doit rester littéral dans l'URL (ne pas percent-encoder le séparateur).

### Opérations de liste (hors périmètre, notées pour mémoire)

- `POST /lists/{id}/move-cards` — *« Moves all cards from a closed list to an archive
  list »*, source `closed`, cible `archive`.
- `POST /lists/{id}/clear` — *« Only works with trash-type lists »*.
- `POST /lists/{id}/sort` — `{ fieldName: name|dueDate|createdAt, order: asc|desc }`.
- `DELETE /lists/{id}` — *« moves its cards to a trash list. Can only delete finite
  lists »* — deuxième occurrence, en creux, de la notion de liste « finie » vs
  « endless ».

---

## 4. Erreurs

Corps uniforme, défini dans `components.responses` :

```jsonc
// 400 — E_MISSING_OR_INVALID_PARAMS
{ "code": "…", "message": "…", "problems": ["\"password\" is required, but it was not defined."] }

// 401 / 403 / 404 / 422
{ "code": "…", "message": "…" }
```

Vérifié en direct sur l'instance :

```
$ curl -s -o /dev/null -w '%{http_code}' https://planka.example.com/api/config
401
{"code":"E_UNAUTHORIZED","message":"Access token is missing, invalid or expired"}
```

Les messages sont techniques et non actionnables (`404 Not Found` nu sur la plupart des
routes) : le serveur MCP doit les réécrire, pas les relayer. `problems` en revanche est
précis et mérite d'être recopié tel quel.

Les permissions apparaissent dans les descriptions plutôt que dans un schéma : la
plupart des écritures exigent *« board editor permissions »*, certaines *« project
manager »*. Un 403 se traduit donc par « le compte n'est pas éditeur de ce tableau ».

---

## 5. Pièges 1.x → 2.x

1. **Les tâches ne sont plus sous la carte.** En 2.x il y a un niveau intermédiaire
   obligatoire, la `TaskList`. Il n'existe **aucune** route `POST /cards/{id}/tasks` ;
   il faut `POST /cards/{cardId}/task-lists` puis
   `POST /task-lists/{taskListId}/tasks`. Ajouter une tâche à une carte fraîchement
   créée coûte donc deux appels, la carte n'ayant aucune task list par défaut.
2. **Les commentaires sont une sous-ressource de la carte**
   (`/cards/{cardId}/comments`), avec leur propre pagination, et sont absents de
   `GET /cards/{id}`.
3. **Les listes sont typées.** `archive` et `trash` sont des listes système du board :
   `POST /boards/{boardId}/lists` n'accepte que `active` et `closed`. Filtrer sur
   `type` avant de proposer une liste comme cible de déplacement.
4. **`position` est requis lors d'un changement de liste**, pas seulement conseillé.

---

## 6. Zones d'ombre de la spec, et ce que l'observation a tranché

Ces points conditionnent des choix d'implémentation. Ils ont été levés le 2026-09-03 sur
une instance Planka **2.2.1**, au moyen d'un projet jetable créé
puis supprimé pour l'occasion : un tableau « Cycle de test », trois listes `active`, une
liste `closed`, deux labels, trois cartes.

**1. « endless list » — tranché, la restriction ne mord pas.** Le terme n'apparaît que
dans `GET /lists/{listId}/cards` (*« must be an endless list »*), et aucun champ de `List`
ne dit si une liste l'est. Observé : la route répond **200 sur une liste `active` d'un
board kanban** comme sur la liste `archive`, avec `search=` fonctionnel dans les deux cas.
La restriction documentée n'est donc pas appliquée telle qu'écrite, au moins sur un board
en vue `kanban`. Conséquence : la route est utilisable plus largement que la spec ne le
laisse croire, mais comme rien ne garantit ce comportement sur les autres vues, le serveur
MCP continue de passer par `GET /boards/{id}` sur le chemin nominal.

**2. `GET /boards/{id}` et les cartes archivées — tranché, elles sont absentes.** Après
archivage d'une carte, la réponse ne contient plus que les cartes des listes `active` et
`closed` ; la carte archivée disparaît entièrement de `included.cards`. Le filtrage
explicite sur le type de liste fait côté serveur MCP est donc redondant — mais il est
conservé : il coûte un `Map.get` et il garantit le même résultat si le comportement change.
Corollaire assumé : une carte archivée est **introuvable** par les outils, y compris pour
la désarchiver. La restauration passe par l'interface Planka, comme annoncé dans la
description de `planka_archive_card`.

**3. Pagination de `GET /boards/{id}` — toujours ouvert.** Aucun champ `total`, aucun
paramètre de page. Le board de test était trop petit (3 cartes) pour révéler une troncature
silencieuse. À surveiller sur un board réellement fourni.

**4. `position` — tranché sur la forme, non documenté sur le fond.** Les valeurs
observées sont bien clairsemées et espacées de 65536 (`65536`, `131072`, `196608` pour
trois listes créées à la suite). Les positions calculées par le serveur — moitié de la
tête, moyenne de deux voisines, queue + 65536 — ont été acceptées telles quelles et ont
produit l'ordre attendu dans les quatre formes de placement (`top`, `bottom`, `after`,
`index`). Rien n'indique une réindexation côté serveur sur ce volume.

**5. Erreur de rédaction dans la spec — confirmée.** Sur
`POST /cards/{cardId}/card-memberships`, le champ `userId` est décrit comme *« ID of the
card to add the user to »*. C'est bien un ID d'utilisateur : l'appel fonctionne avec
l'`userId` d'un `boardMembership`.

**6. Archivage et `isClosed` — tranché, `isClosed` est dérivé du type de liste.**
Il n'existe pas de route « archiver » : c'est un `PATCH /cards/{id}` vers la liste de type
`archive`. Observé, sans jamais écrire le champ :

| Liste d'accueil | `isClosed` | `prevListId` |
|---|---|---|
| `active` | `false` | `null` |
| `closed` | `true` | `null` |
| `archive` | `true` | l'id de la liste précédente |

`isClosed` bascule donc tout seul en déplaçant la carte dans une liste `closed`, et il
n'est pas modifiable directement (absent du corps de `PATCH /cards/{id}`). `prevListId`
n'est renseigné qu'à l'entrée dans `archive`/`trash`, ce qui rend l'archivage réversible.

**7. Format de `dueDate` — confirmé.** Type `string` sans format déclaré.
`2026-01-31T17:00:00.000Z` est accepté et relu à l'identique. Le serveur MCP documente
l'ISO 8601 UTC dans la description du paramètre.

**8. Un board a-t-il toujours une liste `archive` ? — tranché, oui.** Les listes `archive`
et `trash` sont créées **en même temps que le board**, sans intervention, et renvoyées par
`GET /boards/{id}` avec `name: null` et `position: null` :

```
type=active   name='Backlog'    position=65536
type=active   name='En cours'   position=131072
type=active   name='En revue'   position=196608
type=archive  name=None         position=None
type=trash    name=None         position=None
```

Le garde-fou de `planka_archive_card` (échouer proprement si aucune liste `archive`) reste
en place pour le cas d'un board importé ou d'une version antérieure.

---

## 7. Création de structure

Relevées en montant le projet de test, puis mises en œuvre par les outils
`planka_create_project`, `planka_create_board` et `planka_create_list`. Le serveur crée
cette structure mais n'en supprime aucune.

- **`POST /projects/{projectId}/boards` attend du `multipart/form-data`, pas du JSON.**
  C'est la seule route de création dans ce cas, parce qu'elle sert aussi à l'import Trello
  (`importType`, `importFile`). Un `Content-Type: application/json` y échoue.
- **`POST /projects` exige `type`** (`private` | `shared`) en plus de `name`.
- **`DELETE /projects/{id}` refuse un projet qui a encore des boards**, avec
  `422 {"code":"E_UNPROCESSABLE_ENTITY","message":"Must not have boards"}`. Il faut
  supprimer les boards d'abord.
- **Le créateur d'un board en devient automatiquement membre `editor`**, via un
  `boardMembership` créé en même temps. Aucun appel supplémentaire n'est nécessaire pour
  pouvoir s'assigner ses propres cartes.
