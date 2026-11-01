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

// t[i, j] : la longueur de la plus longue sous-suite commune de x[i…] et y[j…].
function tableLcs(x: string[], y: string[]) {
  const n = x.length
  const m = y.length
  const largeur = m + 1
  const t = new Uint32Array((n + 1) * largeur)
  const lcs = (i: number, j: number) => t[i * largeur + j] ?? 0
  const egaux = (i: number, j: number) => i < n && j < m && x[i] === y[j]
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i * largeur + j] = egaux(i, j) ? lcs(i + 1, j + 1) + 1 : Math.max(lcs(i + 1, j), lcs(i, j + 1))
    }
  }
  return { lcs, egaux }
}

// Les morceaux d'un jeton : ses suites de lettres et de chiffres, et chaque signe à part
// (« pommes,poires » : pommes , poires).
const morceaux = (texte: string) => texte.match(/[\p{L}\p{M}\p{N}_]+|[^\p{L}\p{M}\p{N}_]/gu) ?? []

// Au plus tant de morceaux soudés en un seul (« en fin » → « enfin », « 14 h 30 » → « 14h30 »).
const SOUDURE_MAX = 3

const lettres = (morceau: string) => /[\p{L}\p{N}]/u.test(morceau)

// Dans un passage changé, ce que chaque côté a de jetons changés : un jeton dont un morceau
// a changé, ou qu'une soudure ou une coupure touche (« pommes,poires » → « Pommes, poires » ne
// change que « Pommes » ; « quand-même » → « quand même » change les deux mots). Une soudure ou
// une coupure compte pour une correction : `retires` et `nets` (les jetons ajoutés) en tiennent
// compte, `ajoutes` marque chaque jeton ajouté changé, pour la liste du bilan.
function jetonsChanges(x: string[], y: string[]): { retires: number; nets: number; ajoutes: boolean[] } {
  const mx = x.map(morceaux)
  const my = y.map(morceaux)
  const fx = mx.flat()
  const fy = my.flat()
  // Un passage trop long pour être détaillé : tous ses jetons comptent.
  if ((fx.length + 1) * (fy.length + 1) > COMPARAISON_MAX) {
    return { retires: x.length, nets: y.length, ajoutes: y.map(() => true) }
  }
  // Le jeton de chaque morceau.
  const jx = mx.flatMap((ms, k) => ms.map(() => k))
  const jy = my.flatMap((ms, k) => ms.map(() => k))
  const n = fx.length
  const m = fy.length

  // Les groupes possibles en (i, j) : un morceau égal à un morceau, ou plusieurs morceaux
  // d'un côté soudés en un seul de l'autre ; [nombre à gauche, nombre à droite].
  const groupes = (i: number, j: number): [number, number][] => {
    const g: [number, number][] = []
    if (fx[i] === fy[j]) {
      g.push([1, 1])
    }
    for (let p = 2; p <= SOUDURE_MAX; p++) {
      if (i + p <= n && fx.slice(i, i + p).join('') === fy[j]) {
        g.push([p, 1])
      }
      if (j + p <= m && fy.slice(j, j + p).join('') === fx[i]) {
        g.push([1, p])
      }
    }
    return g
  }
  // t[i, j] : le plus grand nombre de groupes gardés entre fx[i…] et fy[j…].
  const largeur = m + 1
  const t = new Uint32Array((n + 1) * largeur)
  const at = (i: number, j: number) => t[i * largeur + j] ?? 0
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      let mieux = Math.max(at(i + 1, j), at(i, j + 1))
      for (const [p, q] of groupes(i, j)) {
        mieux = Math.max(mieux, at(i + p, j + q) + 1)
      }
      t[i * largeur + j] = mieux
    }
  }

  const touchesX = new Array<boolean>(x.length).fill(false)
  const touchesY = new Array<boolean>(y.length).fill(false)
  // Le jeton d'après où va chaque morceau gardé d'avant ; -1 : retiré.
  const vers = new Array<number>(n).fill(-1)
  const gardeY = new Array<boolean>(m).fill(false)
  let soudes = 0
  let coupes = 0
  const distincts = (ks: number[]) => new Set(ks).size
  let i = 0
  let j = 0
  while (i < n && j < m) {
    const groupe = groupes(i, j).find(([p, q]) => at(i + p, j + q) + 1 === at(i, j))
    if (groupe !== undefined) {
      const [p, q] = groupe
      const gx = jx.slice(i, i + p)
      const gy = jy.slice(j, j + q)
      for (let k = i; k < i + p; k++) {
        vers[k] = jy[j] ?? -1
      }
      gy.forEach((_, k) => (gardeY[j + k] = true))
      if (p > 1 || q > 1) {
        gx.forEach(k => (touchesX[k] = true))
        gy.forEach(k => (touchesY[k] = true))
        soudes += distincts(gx) - 1
        coupes += distincts(gy) - 1
      }
      i += p
      j += q
    } else if (at(i, j + 1) === at(i, j)) {
      j++
    } else {
      i++
    }
  }
  fx.forEach((_, k) => {
    if (vers[k] === -1) {
      touchesX[jx[k] ?? 0] = true
    }
  })
  fy.forEach((_, k) => {
    if (!gardeY[k]) {
      touchesY[jy[k] ?? 0] = true
    }
  })
  // Un jeton d'avant coupé là où un signe a disparu (« quand-même » → « quand même ») : les
  // jetons d'après qui en viennent sont changés, et la coupure compte pour une.
  let debut = 0
  mx.forEach(ms => {
    let precedent = -1
    let retire = false
    ms.forEach((morceau, k) => {
      const cible = vers[debut + k] ?? -1
      if (cible === -1) {
        retire = true
      } else if (lettres(morceau)) {
        if (precedent !== -1 && cible !== precedent && retire) {
          for (let c = precedent; c <= cible; c++) {
            touchesY[c] = true
          }
          coupes += cible - precedent
        }
        precedent = cible
        retire = false
      }
    })
    debut += ms.length
  })
  return {
    retires: touchesX.filter(Boolean).length - soudes,
    nets: touchesY.filter(Boolean).length - coupes,
    ajoutes: touchesY,
  }
}

// L'espace entre deux jetons, pour savoir s'il a changé : les sauts de ligne comptent par leur
// nombre (deux lignes fusionnées, un paragraphe de plus), le reste tel quel (« Note: » →
// « Note : », une espace insécable ajoutée).
function ecart(texte: string, debut: number, fin: number) {
  const s = texte.slice(debut, fin)
  const lignes = s.split('\n').length - 1
  return lignes > 0 ? '\n'.repeat(lignes) : s
}

// Compare mot à mot (plus longue sous-suite commune ; accents décomposés ou non, c'est pareil).
// Un passage changé est une suite de jetons retirés, ajoutés ou remplacés entre deux jetons
// gardés ; il compte pour autant de corrections que le plus grand de ses deux côtés, en ne
// comptant que les jetons dont un morceau a changé (« jai checker » → « J'ai checké » : 2 ;
// « pommes,poires » → « Pommes, poires » : 1), et pour une seule quand les lettres restent les
// mêmes (« pommes,poires » → « pommes, poires », « en fin » → « enfin »). Entre deux jetons
// gardés, un espacement changé (« Note: » → « Note : », deux lignes fusionnées) compte aussi
// pour une. Les plages sont les jetons ajoutés, dans le texte d'après ; les mots, ceux du bilan
// (voir motsDuPassage) : un changement d'espacement seul n'y est pas, un mot soudé ou coupé y est.
export function comparer(avant: string, apres: string): { changements: number | null; plages: Plage[]; mots: string[] } {
  const a = jetons(avant)
  const b = jetons(apres)
  const x = a.map(j => j.texte.normalize('NFC'))
  const y = b.map(j => j.texte.normalize('NFC'))
  const n = x.length
  const m = y.length
  if ((n + 1) * (m + 1) > COMPARAISON_MAX) {
    return { changements: null, plages: [], mots: [] }
  }
  const { lcs, egaux } = tableLcs(x, y)

  let changements = 0
  const plages: Plage[] = []
  // Deux plages qui se touchent n'en font qu'une (« 100 % » puis « % prêt »).
  const surligner = (start: number, end: number) => {
    const derniere = plages[plages.length - 1]
    if (derniere !== undefined && start <= derniere.end) {
      derniere.end = Math.max(derniere.end, end)
    } else {
      plages.push({ start, end })
    }
  }
  // Les mots du bilan, sans doublon à la majuscule près ; la première graphie l'emporte.
  const mots = new Map<string, string>()
  let i = 0
  let j = 0
  // Vrai quand le pas précédent gardait un jeton des deux côtés : l'espace entre les deux est
  // alors à comparer.
  let garde = false
  while (i < n || j < m) {
    if (egaux(i, j)) {
      const pa = a[i - 1]
      const pb = b[j - 1]
      const ja = a[i]
      const jb = b[j]
      if (garde && pa && pb && ja && jb && ecart(avant, pa.fin, ja.debut) !== ecart(apres, pb.fin, jb.debut)) {
        changements++
        surligner(pb.debut, jb.fin)
      }
      garde = true
      i++
      j++
      continue
    }
    garde = false
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
    const gauche = x.slice(retire, i)
    const droite = y.slice(premier, j)
    // Les mêmes lettres dans le même ordre : seul l'espacement change, ou deux mots sont
    // soudés (« en fin » → « enfin ») ou coupés ; c'est une correction.
    const memesLettres = gauche.join('') === droite.join('')
    const espacement = memesLettres && gauche.flatMap(morceaux).join('\u0000') === droite.flatMap(morceaux).join('\u0000')
    const changes = memesLettres ? null : jetonsChanges(gauche, droite)
    changements += changes === null ? 1 : Math.max(1, changes.retires, changes.nets)
    const debut = b[premier]
    const fin = b[j - 1]
    if (j > premier && debut !== undefined && fin !== undefined) {
      surligner(debut.debut, fin.fin)
      if (!espacement) {
        // Un jeton dont aucun morceau n'a changé (« poires » dans « Pommes, poires ») n'est pas listé.
        const listes = b.slice(premier, j).filter((_, k) => changes === null || changes.ajoutes[k])
        for (const mot of motsDuPassage(apres, listes)) {
          const cle = mot.toLocaleLowerCase('fr')
          if (!mots.has(cle)) {
            mots.set(cle, mot)
          }
        }
      }
    }
  }
  return { changements, plages, mots: [...mots.values()] }
}

// Les mots d'un passage ajouté, pour le bilan : des mots voisins séparés par une simple espace
// restent ensemble (« J'ai checké ») ; une ponctuation (« , », « . ») ou un saut de ligne les
// sépare, et n'apparaît jamais dans la liste.
function motsDuPassage(apres: string, passage: Jeton[]): string[] {
  const mots: string[] = []
  let groupe: Jeton[] = []
  const fermer = () => {
    const a = groupe[0]
    const z = groupe[groupe.length - 1]
    if (a !== undefined && z !== undefined) {
      mots.push(apres.slice(a.debut, z.fin).replace(/[ \t\u00a0\u202f]+/g, ' ').normalize('NFC'))
    }
    groupe = []
  }
  for (const jeton of passage) {
    const precedent = groupe[groupe.length - 1]
    const ecart = precedent === undefined ? '' : apres.slice(precedent.fin, jeton.debut)
    if (!/[\p{L}\p{N}]/u.test(jeton.texte) || !/^[ \t\u00a0\u202f]*$/.test(ecart)) {
      fermer()
    }
    if (/[\p{L}\p{N}]/u.test(jeton.texte)) {
      groupe.push(jeton)
    }
  }
  fermer()
  return mots
}

// ── Bilan et libellés de la bande ────────────────────────────────────────────

// La version du mod, aussi dans .claude-plugin/plugin.json ; « /lite » l'affiche.
export const VERSION = '1.1.1'

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
  // Les mots corrigés viennent en dernier : sur une bande étroite, c'est leur liste qui est coupée.
  const compte = `${r.changements === 1 ? '1 correction' : `${r.changements} corrections`} · ${temps}`
  // Un bilan gardé dans $.state par la 1.0.0, d'avant un rechargement, n'a pas de liste.
  const mots = r.corriges ?? []
  return mots.length > 0 ? `${compte} · ${mots.join(', ')}` : compte
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
