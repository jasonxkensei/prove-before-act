# Rapport d’implémentation — PBA Verified

**État au 26 septembre 2026 : implémenté en développement ; paiements publics de production désactivés.** Ce document décrit le code et les limites du premier profil, et ne vaut pas autorisation de mise en paiement.

## Périmètre effectivement vérifié

- Le profil ouvert `pba-verified-v1` accepte les producteurs xProof et tiers selon les mêmes règles. Une certification xProof existante n’est jamais une preuve suffisante.
- WHY : identité Ed25519 auto-certifiante, preuve signée, contenu divulgué correspondant à son hachage et engagement constaté sur une transaction MultiversX finalisée.
- ACTION : **transaction MultiversX réelle**, finalisée et réussie, envoyée par l’adresse dérivée de la clé du sujet. Destinataire, montant, nonce et données de la transaction correspondent exactement au document d’action signé à l’avance. Un simple message d’ancrage « ACTION » ne suffit pas.
- WHAT : preuve signée après l’action, hachage de l’action identique, document divulgué et engagement finalisé. Les trois blocs doivent établir un ordre temporel strict WHY < ACTION < WHAT ; une égalité à la seconde reste non concluante.
- Vert : trois verdicts vérifiés. Rouge : contradiction explicite examinée. Blanc : preuve absente, format non pris en charge, finalité incertaine ou prestataire indisponible. Une panne technique n’est pas un rejet.
- Ce profil ne prouve **pas** une action hors chaîne, l’identité civile, la causalité, une intention, ni le résultat sémantique d’un contrat. Les API publiques MultiversX sont recoupées avec les en-têtes de bloc et minibloc ; le serveur ne vérifie pas localement les preuves cryptographiques du consensus BLS. Voir `docs/pba-verified-profile.md` pour le format précis.

## Signature, consultation et indicateur

- Une attestation est signée en Ed25519 sur les **octets canoniques immuables**. Les clés publiques historiques et leur état sont consultables ; le secret privé n’est jamais renvoyé.
- Une révocation ou une succession ajoute un événement signé distinct. La révocation d’une clé exige une nouvelle clé active et annote les attestations touchées dans une transaction atomique ; elle refuse sans mutation un lot de plus de 500 attestations.
- `GET /api/pba/verification/:id` livre l’original, sa signature, sa clé publique et son état courant. `/verify/:id` propose la lecture humaine et les octets vérifiables ; les robots reçoivent un rendu serveur qui utilise les mêmes règles. L’indicateur à trois parties lit le statut public et renvoie vers cette page ; `/indicator.svg` est calculé côté serveur. Une révocation/succession ou une indisponibilité ne peut pas conserver un indicateur global vert.

## Paiement et sûreté

- Prix par défaut : **1 centime de dollar**, paramétrable séparément via `PBA_VERIFICATION_PRICE_CENTS` et publié sur `/api/pricing`. Il rémunère **l’examen achevé**, y compris négatif, jamais un résultat vert. Les demandes malformées sont rejetées gratuitement ; l’examen non concluant reste non facturé et non signé.
- Devis x402 sur l’origine publique canonique, lié au hachage de la demande, au montant, au réseau et au destinataire. Sur Base, 0,01 USD correspond à 10 000 unités atomiques d’USDC à six décimales.
- L’identité de la demande et l’empreinte de l’en-tête de paiement sont revendiquées en base **avant** le règlement. Un règlement incertain reste bloqué en attente de rapprochement : aucune relance automatique ne peut déclencher un second prélèvement. Après un règlement confirmé, la même demande réutilise son reçu pour réexaminer une preuve temporairement indisponible, sans repayer.
- **Activation** : le chemin POST d’émission renvoie 503 en production, sans option d’environnement permettant de contourner cette barrière. En développement, un mode de prévisualisation sans paiement ou un mode de paiement doit être explicitement choisi. Aucun paiement public de production n’a été activé. Aucune clé de signature officielle n’a été provisionnée durant ce travail.

## Vérifications et réserves avant décision de mise en service

- Contrôle de types, compilation de production, 88 assertions ciblées et 22 assertions de compatibilité partenaires réussis. Le rendu web, le rendu robot, le tarif, les lectures publiques et les réponses d’erreur ont été contrôlés avec le serveur de développement.
- Les tables nouvelles ont été ajoutées uniquement à la base de **développement**, sans migration destructive intentionnelle. Aucun règlement réel, émission avec clé officielle ou vérification de bout en bout sur une transaction réelle n’a été effectué.
- Avant une mise en paiement, définir la procédure opérateur de rapprochement d’un règlement incertain et, le cas échéant, de remboursement ; provisionner une clé Ed25519 dédiée par le mécanisme de secrets ; réaliser un essai complet sur un environnement isolé ; revoir la sécurité et la preuve d’action prise en charge. Un rapprochement ne doit jamais supposer qu’un délai expiré équivaut à un échec du paiement.
- Toute extension aux actions hors chaîne nécessite un profil de témoin indépendant propre à ces actions : elle n’est **pas** accordée par le profil actuel.

**Décision demandée au propriétaire :** examiner ce rapport et le périmètre limité aux transactions observables. La mise en paiement publique reste désactivée tant qu’une autorisation distincte n’est pas donnée.

## Complément ultérieur : livraison HTTP attestée par un destinataire

Un second profil distinct, `pba-http-delivery-v1`, permet maintenant d’examiner un **POST accepté par un destinataire témoin indépendant**, dont la clé et l’origine HTTPS ont été vérifiées et enregistrées par l’opérateur. Sa déclaration signée, le contenu divulgué et les preuves WHY/WHAT peuvent être contrôlés à partir de la réponse publique. Cette extension ne prouve pas les effets métier ultérieurs du POST et ne modifie pas le profil de transaction précédent. Elle exige un accusé explicite de publication des preuves ; le corps du POST n’est jamais publié. Aucun témoin tiers ni clé officielle n’a été provisionné dans cette session ; l’émission et les paiements publics en production restent désactivés. Voir `docs/pba-http-delivery-profile.md`.