# Shopping pour Tous — automatisation des images 1688

Worker Cloudflare séparé qui analyse les images des produits 1688, conserve les images propres, retire les textes promotionnels chinois et traduit uniquement les informations essentielles en français.

Le traitement est volontairement prudent : une image originale est conservée dès qu'une analyse ou une retouche n'est pas suffisamment sûre. Le code ne modifie ni les prix, ni le stock, ni les avis, ni les catégories, ni le thème BigCommerce.

## Sécurité

Aucune clé privée n'est stockée dans ce dépôt public. Le déploiement utilise exclusivement des secrets GitHub privés :

- `CLOUDFLARE_API_TOKEN`
- `BIGCOMMERCE_STORE_HASH`
- `BIGCOMMERCE_1688_ACCESS_TOKEN`
- `SPT_1688_CONNECTOR_TOKEN`

Le déploiement est manuel depuis l'onglet **Actions** afin d'éviter tout lancement accidentel.
