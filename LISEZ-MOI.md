# Discussion privée — déploiement Netlify

## Structure
```
chat-netlify/
├── netlify.toml
├── package.json
├── public/index.html                 ← le site (accueil, dashboard, discussion)
└── netlify/functions/api.mjs         ← le serveur (vérifie les codes, stocke les messages)
```

## Déploiement
1. Mets ce dossier sur GitHub (ou utilise `netlify deploy --prod` avec la CLI : `npm i -g netlify-cli`).
   ⚠️ Le glisser-déposer du dossier sur netlify.com ne fonctionne PAS ici, car il y a une fonction serveur à construire.
2. Sur Netlify : *Add new site → Import from Git* (ou `netlify init`).
3. **Avant de tester**, dans *Site configuration → Environment variables*, ajoute :
   - `ADMIN_CODE` : ton code admin (choisis-en un long, avec majuscules, minuscules, chiffres, caractères spéciaux)
   - `SECRET` : une longue chaîne aléatoire (40 caractères ou plus). Exemple de génération : `openssl rand -base64 48`
4. Redéploie le site (*Deploys → Trigger deploy*).

## Fonctionnement
- Toi : tu te connectes avec `ADMIN_CODE` → dashboard (seul toi y as accès, vérifié côté serveur).
- Tu crées une personne → le serveur génère un code de 16 caractères (majuscules + minuscules + chiffres + spéciaux). Il s'affiche **une seule fois** : copie-le et transmets-le.
- Chaque discussion a son propre tableau de messages (`msgs/<id>`), les audios sont stockés à part (`audio/<id>/<msg>`), le tout dans Netlify Blobs.
- À 100 messages, la discussion (messages + audios) est effacée automatiquement.

## Sécurité
- Les codes ne sont jamais stockés : seul un hash HMAC (clé `SECRET`) identifie une discussion.
- Le code admin n'est pas dans le site, il est dans les variables d'environnement.
- Sessions signées (12 h), comparaisons à temps constant, blocage après 8 essais ratés (15 min), en-têtes de sécurité (CSP, anti-iframe), texte affiché sans HTML (anti-XSS), pas d'indexation par les moteurs.
- Un utilisateur ne peut lire/écrire que SA discussion (déduite de son jeton, jamais d'un paramètre).
- Si tu changes `SECRET`, tous les codes existants cessent de fonctionner.

## Limites à connaître
- Les messages sont lus par la page toutes les 3 secondes (pas de WebSocket) : très léger, mais pas instantané.
- Les messages sont stockés en clair côté Netlify (pas de chiffrement de bout en bout) : toute personne ayant accès à ton compte Netlify peut les voir.
- Vocaux : 30 s maximum (~1 Mo).
