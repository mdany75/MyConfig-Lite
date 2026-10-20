// Contrat des valeurs que MyConfig Lite garde dans $.state.

/** Ce que fait un bouton : réécrire en prompt clair, ou corriger les fautes seulement. */
export type Travail = 'ameliorer' | 'corriger'

/** Les modèles proposés, par leur alias. */
export type Modele = 'haiku' | 'sonnet' | 'opus'

/** Les réglages, gardés d'une session à l'autre dans $.store (clé `reglages`). */
export type Reglages = {
  /** Le modèle de « ✎ Améliorer ». */
  ameliorer: Modele
  /** Le modèle de « ✓ Corriger ». */
  corriger: Modele
  /** Vrai : après « ✓ Corriger », les mots changés sont surlignés dans le champ. */
  surlignage: boolean
}

/** Un passage du texte, en positions UTF-16 : du premier caractère à celui qui suit le dernier. */
export type Plage = { start: number; end: number }

/** Le dernier texte mis dans le champ, tant qu'on peut le garder ou revenir au texte d'avant. */
export type Resultat = {
  travail: Travail
  /** Le texte de l'utilisateur avant l'action. */
  avant: string
  /** Le texte que le champ a pris (celui d'avant quand rien n'a changé). */
  apres: string
  /** Les mots corrigés surlignés dans le champ ; vide sans surlignage. */
  plages: Plage[]
  /** Les mots corrigés, dans l'ordre du texte, pour le bilan de « ✓ Corriger » ; vide pour Améliorer. */
  corriges: string[]
  /** Le nombre de passages changés ; rien quand le texte est trop long pour être comparé. */
  changements: number | null
  motsAvant: number
  motsApres: number
  /** La durée de l'appel au modèle, en millisecondes. */
  ms: number
  modele: Modele
}

declare module 'claude-code' {
  interface PluginState {
    'myconfig-lite': {
      /** Le nombre de mots du champ de saisie ; 0 quand il est vide. */
      mots: number
      /** L'action en cours pendant l'appel au modèle, ou rien. */
      travail: Travail | null
      /** Le bilan de la dernière action, jusqu'à Garder, Revenir, une frappe ou l'envoi. */
      resultat: Resultat | null
      /** Les réglages ; rien après un « /clear », qui vide $.state (on relit alors $.store). */
      reglages: Reglages | null
    }
  }
}
