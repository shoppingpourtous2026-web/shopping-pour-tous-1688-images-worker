# Shopping pour Tous — automatisation des images 1688

Worker Cloudflare séparé qui analyse jusqu'à 20 visuels par produit 1688, traduit leurs descriptions en français avec une présentation sobre enrichie d'émojis, conserve les images propres, retire les textes promotionnels chinois et traduit uniquement les informations essentielles visibles sur les images. Si une retouche automatique échoue, le visuel chinois est écarté dès qu'une autre image propre et vérifiée du même produit est disponible.

Le traitement est volontairement prudent : une image ou une description originale est conservée dès qu'une analyse, une traduction ou une retouche n'est pas suffisamment sûre. Les balises HTML, liens, références, dimensions, quantités et autres valeurs chiffrées des descriptions sont verrouillés avant traduction. Le code ne modifie ni les prix, ni le stock, ni le titre, ni les avis, ni les catégories, ni le thème BigCommerce.

## Sécurité

Aucune clé privée n'est stockée dans ce dépôt public. Le déploiement utilise exclusivement des secrets GitHub privés :

- `CLOUDFLARE_API_TOKEN`
- `BIGCOMMERCE_STORE_HASH`
- `BIGCOMMERCE_1688_ACCESS_TOKEN`
- `SPT_1688_CONNECTOR_TOKEN`

Le déploiement est manuel depuis l'onglet **Actions** afin d'éviter tout lancement accidentel.
