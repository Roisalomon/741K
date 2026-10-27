# Discussion privée — Netlify (version 2, sans variables d'environnement)

## Structure
```
chat-netlify/
├── netlify.toml                 ← config Netlify (build + scan de secrets désactivé)
├── package.json                 ← dépendances (@netlify/blobs, tailwindcss)
├── tailwind.config.cjs          ← config Tailwind
├── src/input.css                ← point d'entrée Tailwind
├── public/index.html            ← le site (Tailwind)
├── public/styles.css            ← CSS généré par Tailwind (regénéré à chaque déploiement)
└── netlify/functions/api.mjs    ← le serveur
```

## Déploiement (une seule fois)
1. Remplace les fichiers de ton dépôt GitHub par ceux de ce dossier, puis `git push`.
2. **Supprime** dans Netlify (*Site configuration → Environment variables*) les anciennes variables `ADMIN_CODE` et `SECRET` : elles ne servent plus à rien et c'étaient elles qui faisaient échouer le build.
3. Netlify redéploie tout seul. Si besoin : *Deploys → Trigger deploy → Clear cache and deploy site*.
4. Ouvre ton site : **au tout premier lancement**, il te demande de choisir ton code admin (bouton « Générer un code fort » possible). Fais-le tout de suite après le déploiement, avant de partager l'adresse à qui que ce soit.

C'est tout. Aucune variable à configurer.

## Utilisation
- **Toi** : tu te connectes avec ton code admin → tableau de bord. Tu crées une personne, le serveur génère un code de 16 caractères (majuscules, minuscules, chiffres, caractères spéciaux), affiché **une seule fois** avec un bouton « Copier ». Tu le lui transmets.
- **Elle** : elle entre son code sur l'accueil et arrive directement dans sa discussion.
- Tes messages sont à droite et les siens à gauche chez toi ; l'inverse chez elle.
- Messages vocaux : 30 secondes maximum.
- À 100 messages, la discussion (texte + audios) est effacée automatiquement.
- Dashboard → « Changer mon code admin » pour modifier ton code quand tu veux.

## Faire des mises à jour plus tard
Modifie les fichiers, `git push`, Netlify redéploie. **Les discussions, les codes et ton code admin sont conservés** (ils sont dans Netlify Blobs, indépendamment du code du site).
- Pour changer le design, modifie les classes Tailwind dans `public/index.html` : le CSS est regénéré automatiquement à chaque déploiement (`npm run build`).
- Si la génération Tailwind échoue un jour, le déploiement continue avec le dernier `public/styles.css`.

## Sécurité
- Le code admin est stocké haché (scrypt), les codes utilisateurs ne sont jamais stockés (seule une empreinte HMAC identifie la discussion).
- Le secret de signature est généré automatiquement et n'apparaît dans aucun fichier du dépôt.
- Sessions signées de 12 h, blocage après 8 essais ratés (15 minutes), en-têtes de sécurité (CSP, anti-iframe), pas d'indexation par les moteurs de recherche.
- Chaque utilisateur ne peut lire/écrire que SA discussion (déduite de son jeton). Seule la session admin accède au dashboard (vérifié côté serveur).

## Code admin oublié
Dans les données *Blobs* de ton site sur Netlify, supprime l'entrée `admin` du magasin `chat` : l'écran de première configuration réapparaît, tu choisis un nouveau code, et **les codes des utilisateurs continuent de fonctionner** (le secret est conservé séparément).

## Limites
- Rafraîchissement toutes les 3 secondes (pas de temps réel instantané).
- Messages non chiffrés de bout en bout : visibles par quiconque a accès à ton compte Netlify.
