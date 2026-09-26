# Guide d'acquisition — Prove Before Act

Ce guide décrit les parcours publics pour obtenir une première preuve, passer
en production et choisir un moyen de paiement. Le fichier est volontairement
orienté exécution : les clés et URL sensibles doivent être conservées par
l'opérateur, jamais dans le code source.

## 1. Trial sans wallet

Depuis la landing page, choisissez **Start free** puis enregistrez un agent.
Le même parcours est disponible sans navigateur :

```bash
curl -X POST https://provebeforeact.com/api/agent/register \
  -H "Content-Type: application/json" \
  -d '{"agent_name":"mon-agent"}'
```

La réponse contient une clé `pm_` et 10 certifications gratuites. La clé
complète est affichée une seule fois : copiez-la immédiatement, téléchargez
la sauvegarde proposée par l'interface et stockez-la dans un gestionnaire de
secrets. Ne la mettez pas dans Git, une URL ou un log.

## 2. Première preuve

Calculez le SHA-256 localement : le fichier source ne quitte pas votre
environnement. Puis utilisez la clé :

```bash
curl -X POST https://provebeforeact.com/api/proof \
  -H "Authorization: Bearer pm_VOTRE_CLE" \
  -H "Content-Type: application/json" \
  -d '{"file_hash":"<64 caractères hexadécimaux>","filename":"decision.json"}'
```

Conservez `proof_id` et utilisez ensuite :

- `/proof/<id>` pour la page humaine ;
- `/proof/<id>.json` pour le JSON ;
- `/api/certificates/<id>.pdf` pour le certificat PDF.

## 3. Connexion wallet et destination

La connexion MultiversX sert aux écrans interactifs, au dashboard, aux clés
API permanentes et aux packs de crédits. Elle utilise Native Auth et une
signature wallet. Les liens protégés conservent leur destination après la
connexion ; si vous arrivez sur le dashboard, utilisez le CTA correspondant
à l'action voulue.

## 4. MCP

Le serveur canonique est `POST /mcp`. Sans clé, appelez `register_trial`;
avec une clé, utilisez notamment `certify_file`, `verify_proof`,
`audit_agent_session` et `investigate_proof`. Appelez toujours `tools/list`
ou `discover_services` pour obtenir le catalogue et les schémas actuels :
la liste publique n'est pas exhaustive.

Voir [le guide MCP](./mcp.md) et la page agent
[`/agent-context`](https://provebeforeact.com/agent-context).

## 5. Paiements

- **Trial** : 10 preuves, sans wallet.
- **x402 / USDC sur Base** : aucun compte requis. Envoyez `POST /api/proof`
  sans auth, recevez `402`, signez le paiement, puis renvoyez la requête avec
  `X-PAYMENT`.
- **USDC/Base prépayé** : utilisez `/api/credits/purchase` puis
  `/api/credits/confirm` avec une clé API.
- **Stripe** : utilisez `POST /api/credits/stripe/checkout` avec une session
  wallet ou une clé API. Les crédits ne sont ajoutés qu'après le webhook
  Stripe signé ; attendez le statut `paid`.

Le prix courant est toujours celui de `/api/pricing`. Ne codez pas un prix
fixe dans un agent.

## 6. Routes canoniques

- Français/anglais : `/`, `/agent-context`, `/docs`, `/billing`.
- Chinois : `/zh` pour la landing et `/agent-context/zh` pour la documentation
  agent. L'ancien alias `/agents/zh` redirige vers cette URL canonique.
- MCP : `/mcp`.
- Documentation machine : `/llms.txt`, `/llms-full.txt` et les manifests
  `/.well-known/`.

Pour les détails API, consulter [API Reference](./api-reference.md),
[Agent Integration](./agent-integration.md) et [x402](./x402.md).