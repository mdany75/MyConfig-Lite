# Changements

## 1.1.1 — 2026-11-01

- Une correction d'espaces seule (« Note: » → « Note : », deux lignes fusionnées) est comptée et
  surlignée : le bilan ne dit plus « Aucune faute » alors que le texte a changé.
- Deux mots soudés ou coupés (« en fin » → « enfin », « quand-même » → « quand même ») sont
  listés dans le bilan, et comptent pour une correction même à côté d'une autre faute.
- Un passage qui mêle espace et vraie correction ne compte plus que les mots changés
  (« pommes,poires » → « Pommes, poires » : 1 correction, « Pommes »).
- La bande suit le champ quand il change sans frappe : vidé par Échap, prompt rappelé de
  l'historique, annulation, dictée.

## 1.1.0 — 2026-10-20

- Le bilan de « ✓ Corriger » liste les mots corrigés (« 5 corrections · 1,5 s · J'ai checké,
  fichier, ça »), une fois chacun, même sur plusieurs lignes. L'app de bureau ne dessine pas le
  surlignage dans le champ : la liste en tient lieu pour les mots ; la ponctuation et les espaces
  corrigées sont comptées, pas listées. Sur une bande étroite, c'est la fin de la liste qui est
  coupée.
- Le compte et la liste décrivent le texte que le champ a vraiment pris.
- Les captures d'écran de la bande dans l'app de bureau sont dans le README.

## 1.0.0 — 2026-10-20

Première version publiée : le module Correction de MyConfig, repris seul et refait de zéro.

- Une bande qui n'apparaît que si le champ de saisie a du texte, avec le nombre de mots,
  « ✎ Améliorer » et « ✓ Corriger ».
- Pendant l'appel au modèle : le travail en cours, le modèle, et Annuler.
- Après : un bilan (corrections, mots, durée), Garder ou Revenir, et les mots corrigés surlignés
  dans le champ.
- Nouvelles consignes des deux boutons, choisies et vérifiées sur de vraies dictées.
- Un modèle par bouton (Sonnet pour Améliorer, Opus pour Corriger par défaut) et le surlignage,
  réglables avec `/lite`.
