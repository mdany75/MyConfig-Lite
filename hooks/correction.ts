// Fonctions pures de MyConfig Lite : l'envoi au modèle, sa réponse, le bilan affiché dans la
// bande, les passages à surligner et les réglages. Tout ce qui touche au moteur ($) reste dans
// register.tsx.
import type { Modele, Plage, Reglages, Resultat, Travail } from '../types'

// ── Envoi et réponse ──────────────────────────────────────────────────────────

export const enveloppe = (texte: string) => `<texte_brut>\n${texte}\n</texte_brut>`

const OUVRE = '<texte_final>'
const FERME = '</texte_final>'

// La place laissée à la réponse : une correction est aussi longue que le texte ; un jeton vaut
// au moins deux caractères, et le plafond reste sous la limite de chaque modèle.
export const jetonsMax = (texte: string) => Math.min(32_000, 1_024 + Math.ceil(texte.length / 2))
// Le temps laissé à l'appel, selon la longueur du texte.
export const delaiMax = (texte: string) => Math.min(300_000, 90_000 + texte.length * 10)

// Seul le texte entre <texte_final> et </texte_final> compte : le modèle l'entoure parfois d'un
// commentaire (« Voici : ») ou se reprend après une première version, et le dernier bloc
// l'emporte. Quand le texte d'origine cite lui-même ces balises, le bloc va de la première
// ouvrante à la dernière fermante. Une balise ouvrante sans fermante est une réponse coupée
// (limite de longueur) : rien n'est gardé (null). Sans balise, toute la réponse.
// Un bloc de code ajouté par le modèle autour de la réponse est retiré, jamais celui de l'auteur.
export function nettoyer(texte: string, original = ''): string | null {
  const cite = original.includes(OUVRE) || original.includes(FERME)
  const debut = cite ? texte.indexOf(OUVRE) : texte.lastIndexOf(OUVRE)
  let t = texte
  if (debut !== -1) {
    const fin = cite ? texte.lastIndexOf(FERME) : texte.indexOf(FERME, debut)
    if (fin === -1 || fin < debut) {
      return null
    }
    t = texte.slice(debut + OUVRE.length, fin)
  }
  t = t.trim()
  if (!/^\s*```/.test(original)) {
    const bloc = /^```[\w+#.-]*\n((?:(?!\n```)[\s\S])*)\n```$/.exec(t)
    if (bloc?.[1] !== undefined) {
      t = bloc[1]
    }
  }
  return t.trim()
}

// Une commande (« /compact ») ou le mode bash (« ! ») : ni bande, ni réécriture. Un chemin
// (« /Users/… ») n'en est pas une.
export function estCommande(texte: string) {
  return /^\s*(\/[\w:-]+(\s|$)|!)/.test(texte)
}

export function raisonRefus(refusal: 'no_composer' | 'dialog' | undefined) {
  if (refusal === 'no_composer') {
    return "cette fenêtre n'expose pas son champ de saisie aux mods"
  }
  if (refusal === 'dialog') {
    return 'une boîte de dialogue est ouverte'
  }
  return 'le champ a refusé le texte'
}

export type Echec =
  | { reason: 'api-error'; status: number | null; error: string }
  | { reason: 'empty-reply' | 'aborted' | string; status?: undefined; error?: undefined }

// Ce que l'utilisateur peut faire, selon l'erreur.
export function raisonEchec(r: Echec, delaiMs: number) {
  if (r.reason === 'api-error') {
    switch (r.error) {
      case 'overloaded':
        return 'serveur surchargé, réessaie dans un instant'
      case 'rate_limit':
        return 'limite d’utilisation atteinte'
      case 'authentication_failed':
        return 'session non connectée : reconnecte-toi avec /login'
      default:
        return r.status === null || r.status === undefined ? 'pas de réponse du serveur' : `erreur de l'API (${r.status})`
    }
  }
  if (r.reason === 'empty-reply') {
    return 'réponse vide'
  }
  if (r.reason === 'aborted') {
    return `délai de ${Math.round(delaiMs / 1000)} s dépassé`
  }
  return r.reason
}

export const nomTravail = (travail: Travail) => (travail === 'ameliorer' ? 'la reformulation' : 'la correction')

// ── Mots et passages changés ─────────────────────────────────────────────────

// Un mot contient au moins une lettre ou un chiffre : « ? », « : » ou « – » isolés ne comptent pas.
export function compterMots(texte: string) {
  return texte.split(/\s+/).filter(m => /[\p{L}\p{N}]/u.test(m)).length
}

export const libelleMots = (n: number) => (n === 1 ? '1 mot' : `${n} mots`)

type Jeton = { texte: string; debut: number; fin: number }

// Un mot garde sa ponctuation interne (« j'aimerais », « register.tsx », « 1,5 ») et ses accents
// décomposés ; toute autre ponctuation est un jeton à elle seule, pour qu'une virgule ajoutée
// compte sans le mot voisin. Un emoji composé (👍🏽, ❤️, famille) reste un seul jeton.
const JETON =
  /[\p{L}\p{M}\p{N}_]+(?:['’.,\-/:][\p{L}\p{M}\p{N}_]+)*|[^\s\p{L}\p{M}\p{N}_][\p{M}\p{Emoji_Modifier}]*(?:‍[^\s\p{L}\p{M}\p{N}_][\p{M}\p{Emoji_Modifier}]*)*/gu

export function jetons(texte: string): Jeton[] {
  return Array.from(texte.matchAll(JETON), m => ({ texte: m[0], debut: m.index, fin: m.index + m[0].length }))
}

/** Au-delà, la comparaison coûterait trop cher : pas de compte ni de surlignage. */
export const COMPARAISON_MAX = 4_000_000

// Compare mot à mot (plus longue sous-suite commune). Un passage changé est une suite de jetons
// retirés, ajoutés ou remplacés entre deux jetons gardés ; il compte pour autant de corrections
// que le plus grand de ses deux côtés (« jai checker » → « J'ai checké » : 2), et pour une seule
// quand seul l'espacement change (« pommes,poires » → « pommes, poires »). Les plages sont les
// jetons ajoutés, dans le texte d'après.
export function comparer(avant: string, apres: string): { changements: number | null; plages: Plage[] } {
  const b = jetons(apres)
  const x = jetons(avant).map(j => j.texte)
  const y = b.map(j => j.texte)
  const n = x.length
  const m = y.length
  if ((n + 1) * (m + 1) > COMPARAISON_MAX) {
    return { changements: null, plages: [] }
  }

  // t[i, j] : la longueur de la plus longue sous-suite commune de x[i…] et y[j…].
  const largeur = m + 1
  const t = new Uint32Array((n + 1) * largeur)
  const lcs = (i: number, j: number) => t[i * largeur + j] ?? 0
  const egaux = (i: number, j: number) => i < n && j < m && x[i] === y[j]
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i * largeur + j] = egaux(i, j) ? lcs(i + 1, j + 1) + 1 : Math.max(lcs(i + 1, j), lcs(i, j + 1))
    }
  }

  let changements = 0
  const plages: Plage[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (egaux(i, j)) {
      i++
      j++
      continue
    }
    // Un passage changé : on avance jusqu'au prochain jeton gardé des deux côtés.
    const premier = j
    const retire = i
    while ((i < n || j < m) && !egaux(i, j)) {
      if (j < m && (i === n || lcs(i, j + 1) >= lcs(i + 1, j))) {
        j++
      } else {
        i++
      }
    }
    const espacement = x.slice(retire, i).join('') === y.slice(premier, j).join('')
    changements += espacement ? 1 : Math.max(i - retire, j - premier)
    const debut = b[premier]
    const fin = b[j - 1]
    if (j > premier && debut !== undefined && fin !== undefined) {
      plages.push({ start: debut.debut, end: fin.fin })
    }
  }
  return { changements, plages }
}

// ── Bilan et libellés de la bande ────────────────────────────────────────────

export const NOMS: Record<Modele, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' }

// Arrondir d'abord, comparer ensuite : 9,96 s donne « 10 s », 59,6 s « 1 min 00 s ».
export function duree(ms: number) {
  const dixiemes = Math.round(ms / 100)
  if (dixiemes < 100) {
    return `${(dixiemes / 10).toFixed(1).replace('.', ',')} s`
  }
  const s = Math.round(ms / 1000)
  if (s < 60) {
    return `${s} s`
  }
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`
}

export function enCours(travail: Travail, modele: Modele) {
  return `${travail === 'ameliorer' ? 'Reformulation…' : 'Correction…'} · ${NOMS[modele]}`
}

/** Vrai quand l'action n'a rien changé, aux espaces du début et de la fin près. */
export const inchange = (r: Pick<Resultat, 'avant' | 'apres'>) => r.avant.trim() === r.apres.trim()

export function bilan(r: Resultat) {
  const temps = duree(r.ms)
  if (inchange(r) || (r.travail === 'corriger' && r.changements === 0)) {
    return `${r.travail === 'ameliorer' ? 'Déjà clair, rien à changer' : 'Aucune faute'} · ${temps}`
  }
  if (r.travail === 'ameliorer') {
    return `Prompt amélioré · ${r.motsAvant} → ${libelleMots(r.motsApres)} · ${temps}`
  }
  if (r.changements === null) {
    return `Texte corrigé · ${temps}`
  }
  return `${r.changements === 1 ? '1 correction' : `${r.changements} corrections`} · ${temps}`
}

// ── Réglages ─────────────────────────────────────────────────────────────────

export const MODELES: readonly Modele[] = ['haiku', 'sonnet', 'opus']

// Choisis par l'essai du 20 octobre 2026 : Sonnet réécrit sans faute grave et vite ; pour corriger,
// Opus ne laisse aucune faute grave là où Sonnet en laisse une ou deux sur 20 dictées.
export const DEFAUT: Reglages = { ameliorer: 'sonnet', corriger: 'opus', surlignage: true }

const estModele = (x: unknown): x is Modele => typeof x === 'string' && (MODELES as readonly string[]).includes(x)

// Un réglage absent ou invalide (store vide, ancienne version) prend sa valeur par défaut.
export function completer(x: unknown): Reglages {
  const r = typeof x === 'object' && x !== null ? (x as Record<string, unknown>) : {}
  return {
    ameliorer: estModele(r.ameliorer) ? r.ameliorer : DEFAUT.ameliorer,
    corriger: estModele(r.corriger) ? r.corriger : DEFAUT.corriger,
    surlignage: typeof r.surlignage === 'boolean' ? r.surlignage : DEFAUT.surlignage,
  }
}

export const memesReglages = (a: Reglages, b: Reglages) =>
  a.ameliorer === b.ameliorer && a.corriger === b.corriger && a.surlignage === b.surlignage

export function resume(r: Reglages) {
  return [
    `✎ Améliorer : ${NOMS[r.ameliorer]}`,
    `✓ Corriger : ${NOMS[r.corriger]}`,
    `Surlignage des corrections : ${r.surlignage ? 'activé' : 'désactivé'}`,
  ].join('\n')
}

export const USAGE = [
  '« /lite modele haiku | sonnet | opus » : le modèle des deux boutons',
  '« /lite ameliorer <modèle> », « /lite corriger <modèle> » : le modèle d’un seul bouton',
  '« /lite surlignage on | off » : surligner ou non les mots corrigés',
].join('\n')

const sansAccents = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

export function appliquer(r: Reglages, args: string): { reglages: Reglages; message: string } | { erreur: string } {
  const mots = sansAccents(args).trim().split(/\s+/)
  const [cle, valeur] = mots
  if (mots.length === 2 && (cle === 'modele' || cle === 'ameliorer' || cle === 'corriger')) {
    if (!estModele(valeur)) {
      return { erreur: `MyConfig Lite : modèle inconnu « ${valeur} ». Choix : haiku, sonnet, opus.` }
    }
    if (cle === 'modele') {
      return { reglages: { ...r, ameliorer: valeur, corriger: valeur }, message: `MyConfig Lite : les deux boutons utilisent ${NOMS[valeur]}.` }
    }
    const bouton = cle === 'ameliorer' ? '✎ Améliorer' : '✓ Corriger'
    return { reglages: { ...r, [cle]: valeur }, message: `MyConfig Lite : ${bouton} utilise ${NOMS[valeur]}.` }
  }
  if (mots.length === 2 && cle === 'surlignage' && (valeur === 'on' || valeur === 'off')) {
    return {
      reglages: { ...r, surlignage: valeur === 'on' },
      message: `MyConfig Lite : surlignage des corrections ${valeur === 'on' ? 'activé' : 'désactivé'}.`,
    }
  }
  return { erreur: `MyConfig Lite : je ne comprends pas « ${args.trim()} ».\n${USAGE}` }
}
