import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptDecoration } from 'claude-code'

import { CONSIGNE_AMELIORER, CONSIGNE_CORRIGER } from '../hooks/consignes'
import {
  appliquer,
  bilan,
  comparer,
  compterMots,
  completer,
  DEFAUT,
  duree,
  enveloppe,
  estCommande,
  jetons,
  jetonsMax,
  nettoyer,
  raisonEchec,
  resume,
} from '../hooks/correction'

const SURFACES = ['terminal', 'desktop'] as const

const bande = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 12,
    bodyColumns: 140,
    scroll: { offset: 0, bodyRows: 11 },
    view: {},
  },
} as const

const USAGE = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

const BRUT = 'jai checker le fichié pis sa marche pas'
const CORRIGE = "J'ai checké le fichier, pis ça marche pas."
const AMELIORE = 'Vérifie pourquoi le fichier ne fonctionne pas.'

type Champ = { text: string; decorations: PromptDecoration[] | undefined }

type Simulation = {
  /** La réponse brute du modèle selon le bouton ; par défaut, balisée. */
  corriger?: string
  ameliorer?: string
  /** Appelé pendant l'appel au modèle, avant sa réponse (attendre, changer le champ). */
  pendant?: () => Promise<void> | void
}

// Le moteur sous le mod : le champ de saisie, le modèle, les toasts et l'horloge.
function simuler(on: On, s: Simulation = {}) {
  mock.store(on, {})
  const horloge = mock.clock(on, { now: 1_000_000 })
  const champ: Champ = { text: '', decorations: undefined }
  const consignes: string[] = []
  const toasts: string[] = []
  on('prompt.read', () => ({ value: { text: champ.text, cursor: champ.text.length } }))
  on('prompt.fill', (_$, e) => {
    champ.text = e.text
    champ.decorations = e.decorations
    return { isFilled: true }
  })
  on('model.complete', async (_$, e) => {
    const system = typeof e.system === 'string' ? e.system : ''
    consignes.push(system)
    await s.pendant?.()
    const texte =
      system === CONSIGNE_CORRIGER
        ? (s.corriger ?? `Voici :\n<texte_final>\n${CORRIGE}\n</texte_final>`)
        : (s.ameliorer ?? `<texte_final>${AMELIORE}</texte_final>`)
    return { value: { isAnswered: true as const, text: texte, usage: USAGE } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_$, e) => {
    if (e.origin.kind === 'composer') {
      champ.text = ''
    }
    return { text: e.text }
  })
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine' as const, ref: 0 }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return { champ, consignes, toasts, horloge }
}

// Le kit ne raise pas `prompt.edit` : le texte arrive dans le champ et la relecture du mod
// (chaque seconde, tant qu'aucune frappe n'est remontée) le voit.
async function taper(champ: Champ, horloge: { advance: (ms: number) => Promise<unknown> }, texte: string) {
  champ.text = texte
  champ.decorations = undefined
  await horloge.advance(1_100)
}

async function demarrer($: Engine, surface: 'terminal' | 'desktop' = 'desktop') {
  await $.session.start({ cwd: '/tmp', surface, isInteractive: true })
}

async function lite($: Engine, args: string) {
  const r = await $.command.run({ command: 'lite', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 140 } })
  return (r as { text: string }).text
}

const surligne = (champ: Champ) => champ.decorations?.map(d => champ.text.slice(d.start, d.end))

describe('fonctions pures', () => {
  test('seul le dernier bloc <texte_final> compte ; une réponse coupée ne donne rien', () => {
    expect(nettoyer(`Voici :\n<texte_final>\n${CORRIGE}\n</texte_final>`)).toBe(CORRIGE)
    expect(nettoyer(`<texte_final>a</texte_final> puis <texte_final>b</texte_final>`)).toBe('b')
    expect(nettoyer('sans balise')).toBe('sans balise')
    expect(nettoyer('<texte_final>\nPremière moitié du texte, la suite est')).toBeNull()
    expect(enveloppe('x')).toBe('<texte_brut>\nx\n</texte_brut>')
  })

  test('nettoyer garde les balises citées par l’auteur', () => {
    const cite = 'Dans nettoyer, garde le texte entre <texte_final> et </texte_final>.'
    expect(nettoyer(`<texte_final>${cite}</texte_final>`, cite)).toBe(cite)
  })

  test('nettoyer retire le bloc de code ajouté par le modèle, jamais celui de l’auteur', () => {
    expect(nettoyer('<texte_final>\n```\nbonjour\n```\n</texte_final>', 'bonjour')).toBe('bonjour')
    expect(nettoyer('<texte_final>\n```text\nbonjour\n```\n</texte_final>', 'bonjour')).toBe('bonjour')
    const deux = '```\nerreur 1\n```\net aussi\n```\nerreur 2\n```'
    expect(nettoyer(`<texte_final>${deux}</texte_final>`, deux)).toBe(deux)
    const seul = '```\nnpm run build\n```'
    expect(nettoyer(`<texte_final>${seul}</texte_final>`, seul)).toBe(seul)
  })

  test('une commande ou le mode bash, pas un chemin', () => {
    expect(estCommande('/compact garde les décisions')).toBe(true)
    expect(estCommande('/lite')).toBe(true)
    expect(estCommande('! ls -la')).toBe(true)
    expect(estCommande('/Users/dany/Developer est le dossier')).toBe(false)
    expect(estCommande('corrige ce texte')).toBe(false)
  })

  test('les mots gardent leur ponctuation interne, la ponctuation seule est un jeton', () => {
    expect(jetons("j'aimerais register.tsx, 1,5 fois.").map(j => j.texte)).toEqual(["j'aimerais", 'register.tsx', ',', '1,5', 'fois', '.'])
    expect(jetons('fichié').length).toBe(1)
    expect(jetons('👍🏽 ❤️ 👨‍👩‍👧').length).toBe(3)
  })

  test('les mots : la ponctuation isolée ne compte pas', () => {
    expect(compterMots('Tu viens ? Oui !')).toBe(3)
    expect(compterMots('« bonjour »')).toBe(1)
    expect(compterMots(BRUT)).toBe(8)
    expect(compterMots('   ')).toBe(0)
  })

  test('comparer compte les corrections et surligne les ajouts', () => {
    const { changements, plages } = comparer(BRUT, CORRIGE)
    // jai → J'ai, checker → checké, fichié → fichier, la virgule, sa → ça, le point final.
    expect(changements).toBe(6)
    expect(plages.map(p => CORRIGE.slice(p.start, p.end))).toEqual(["J'ai checké", 'fichier,', 'ça', '.'])
    expect(comparer('un deux trois', 'un 2 3 trois')).toEqual({ changements: 2, plages: [{ start: 3, end: 6 }] })
    expect(comparer('le le chat', 'le chat')).toEqual({ changements: 1, plages: [] })
    expect(comparer('pareil', 'pareil')).toEqual({ changements: 0, plages: [] })
    expect(comparer('pommes,poires et kiwis', 'pommes, poires et kiwis').changements).toBe(1)
    expect(comparer('le fichié est la', 'le fichier est là').changements).toBe(2)
    expect(comparer('merci 👨‍👩‍👧', 'merci').changements).toBe(1)
    const long = 'mot '.repeat(2500)
    expect(comparer(long, long + 'fin').changements).toBeNull()
  })

  test('le bilan et la durée', () => {
    const base = { avant: BRUT, apres: CORRIGE, plages: [], changements: 6, motsAvant: 8, motsApres: 8, ms: 1140, modele: 'haiku' as const }
    expect(bilan({ ...base, travail: 'corriger' })).toBe('6 corrections · 1,1 s')
    expect(bilan({ ...base, travail: 'corriger', changements: 1 })).toBe('1 correction · 1,1 s')
    expect(bilan({ ...base, travail: 'corriger', changements: 0 })).toBe('Aucune faute · 1,1 s')
    expect(bilan({ ...base, travail: 'corriger', apres: BRUT })).toBe('Aucune faute · 1,1 s')
    expect(bilan({ ...base, travail: 'corriger', avant: `${CORRIGE} `, changements: 0 })).toBe('Aucune faute · 1,1 s')
    expect(bilan({ ...base, travail: 'corriger', changements: null })).toBe('Texte corrigé · 1,1 s')
    expect(bilan({ ...base, travail: 'ameliorer', motsApres: 7, ms: 18_400 })).toBe('Prompt amélioré · 8 → 7 mots · 18 s')
    expect(bilan({ ...base, travail: 'ameliorer', apres: BRUT })).toBe('Déjà clair, rien à changer · 1,1 s')
    expect([duree(1140), duree(9960), duree(59_600), duree(75_000), duree(119_600)]).toEqual([
      '1,1 s',
      '10 s',
      '1 min 00 s',
      '1 min 15 s',
      '2 min 00 s',
    ])
  })

  test('la place laissée à la réponse suit la longueur du texte', () => {
    expect(jetonsMax('court')).toBe(1027)
    expect(jetonsMax('x'.repeat(200_000))).toBe(32_000)
  })

  test('les erreurs disent quoi faire', () => {
    expect(raisonEchec({ reason: 'api-error', status: 529, error: 'overloaded' }, 90_000)).toBe('serveur surchargé, réessaie dans un instant')
    expect(raisonEchec({ reason: 'api-error', status: null, error: 'unknown' }, 90_000)).toBe('pas de réponse du serveur')
    expect(raisonEchec({ reason: 'api-error', status: 500, error: 'server_error' }, 90_000)).toBe("erreur de l'API (500)")
    expect(raisonEchec({ reason: 'aborted' }, 90_000)).toBe('délai de 90 s dépassé')
  })

  test('les réglages : défauts, commandes, valeurs invalides', () => {
    expect(completer(undefined)).toEqual(DEFAUT)
    expect(completer({ ameliorer: 'gpt', corriger: 'haiku', surlignage: 'oui' })).toEqual({ ...DEFAUT, corriger: 'haiku' })
    expect(appliquer(DEFAUT, 'modèle Opus')).toEqual({
      reglages: { ...DEFAUT, ameliorer: 'opus', corriger: 'opus' },
      message: 'MyConfig Lite : les deux boutons utilisent Opus.',
    })
    expect(appliquer(DEFAUT, 'améliorer haiku')).toEqual({
      reglages: { ...DEFAUT, ameliorer: 'haiku' },
      message: 'MyConfig Lite : ✎ Améliorer utilise Haiku.',
    })
    expect(appliquer(DEFAUT, 'surlignage off')).toMatchObject({ reglages: { ...DEFAUT, surlignage: false } })
    expect('erreur' in appliquer(DEFAUT, 'corriger gpt')).toBe(true)
    expect('erreur' in appliquer(DEFAUT, 'n’importe quoi')).toBe(true)
    expect(resume(DEFAUT)).toContain('Surlignage des corrections : activé')
  })
})

describe('la bande', () => {
  for (const surface of SURFACES) {
    test(`champ vide : rien ; du texte : le nombre de mots et les deux boutons (${surface})`, async ($, on) => {
      const { champ, horloge } = simuler(on)
      await demarrer($, surface)
      const ui = await $.ui.mount({ plugin: 'myconfig-lite', surface, ...bande })
      expect(await ui.find({ key: 'myconfig-lite' })).toBeUndefined()

      await taper(champ, horloge, BRUT)
      expect(await ui.find({ type: 'Text', text: '8 mots' })).toBeDefined()
      expect((await ui.find({ type: 'Button', key: 'ameliorer' }))?.props.label).toBe('✎ Améliorer')
      expect((await ui.find({ type: 'Button', key: 'corriger' }))?.props.label).toBe('✓ Corriger')
      const arbre = JSON.stringify(await ui.drawn())
      expect(arbre.indexOf('"ameliorer"')).toBeLessThan(arbre.indexOf('"corriger"'))

      await taper(champ, horloge, '')
      expect(await ui.find({ key: 'myconfig-lite' })).toBeUndefined()

      // Une commande n'a pas de bande : elle ne se réécrit pas.
      await taper(champ, horloge, '/compact garde les décisions')
      expect(await ui.find({ key: 'myconfig-lite' })).toBeUndefined()
      await ui.unmount()
    })

    test(`« ✓ Corriger » : texte corrigé et surligné, bilan, puis « ↺ Revenir » (${surface})`, async ($, on) => {
      const { champ, consignes, horloge } = simuler(on)
      await demarrer($, surface)
      const ui = await $.ui.mount({ plugin: 'myconfig-lite', surface, ...bande })
      await taper(champ, horloge, BRUT)

      await ui.press({ key: 'corriger' })
      expect(consignes).toEqual([CONSIGNE_CORRIGER])
      expect(champ.text).toBe(CORRIGE)
      expect(surligne(champ)).toEqual(["J'ai checké", 'fichier,', 'ça', '.'])
      expect(await ui.find({ type: 'Text', text: /^6 corrections · / })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'garder' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'corriger' })).toBeUndefined()

      await ui.press({ key: 'revenir' })
      expect(champ.text).toBe(BRUT)
      expect(await ui.find({ type: 'Button', key: 'corriger' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '8 mots' })).toBeDefined()
      await ui.unmount()
    })

    test(`« ✓ Corriger » puis « Garder » : le texte reste, sans surlignage (${surface})`, async ($, on) => {
      const { champ, horloge } = simuler(on)
      await demarrer($, surface)
      const ui = await $.ui.mount({ plugin: 'myconfig-lite', surface, ...bande })
      await taper(champ, horloge, BRUT)
      await ui.press({ key: 'corriger' })
      expect(champ.decorations).toBeDefined()

      await ui.press({ key: 'garder' })
      expect(champ.text).toBe(CORRIGE)
      expect(champ.decorations).toBeUndefined()
      expect(await ui.find({ type: 'Button', key: 'corriger' })).toBeDefined()
      await ui.unmount()
    })

    test(`« ✎ Améliorer » : prompt réécrit sans surlignage ; « Garder » le laisse (${surface})`, async ($, on) => {
      const { champ, consignes, horloge } = simuler(on)
      await demarrer($, surface)
      const ui = await $.ui.mount({ plugin: 'myconfig-lite', surface, ...bande })
      await taper(champ, horloge, BRUT)

      await ui.press({ key: 'ameliorer' })
      expect(consignes).toEqual([CONSIGNE_AMELIORER])
      expect(champ.text).toBe(AMELIORE)
      expect(champ.decorations).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /^Prompt amélioré · 8 → 7 mots · / })).toBeDefined()

      await ui.press({ key: 'garder' })
      expect(champ.text).toBe(AMELIORE)
      expect(await ui.find({ type: 'Button', key: 'ameliorer' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '7 mots' })).toBeDefined()
      await ui.unmount()
    })

    test(`pendant l'appel : le travail, le modèle et « Annuler », qui laisse le champ intact (${surface})`, async ($, on) => {
      let liberer: (() => void) | undefined
      const { champ, horloge, toasts } = simuler(on, { pendant: () => new Promise<void>(r => (liberer = r)) })
      await demarrer($, surface)
      const ui = await $.ui.mount({ plugin: 'myconfig-lite', surface, ...bande })
      await taper(champ, horloge, BRUT)

      const presse = ui.press({ key: 'corriger' })
      for (let k = 0; k < 50 && liberer === undefined; k++) {
        await horloge.advance(10)
      }
      expect(await ui.find({ type: 'Text', text: 'Correction… · Opus' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'corriger' })).toBeUndefined()

      await ui.press({ key: 'annuler' })
      liberer?.()
      await presse
      expect(champ.text).toBe(BRUT)
      expect(toasts).toEqual([])
      expect(await ui.find({ type: 'Button', key: 'corriger' })).toBeDefined()
      await ui.unmount()
    })

    test(`une frappe après l'action retire le bilan ; l'envoi vide la bande (${surface})`, async ($, on) => {
      const { champ, horloge } = simuler(on)
      await demarrer($, surface)
      const ui = await $.ui.mount({ plugin: 'myconfig-lite', surface, ...bande })
      await taper(champ, horloge, BRUT)
      await ui.press({ key: 'corriger' })
      expect(await ui.find({ type: 'Button', key: 'revenir' })).toBeDefined()

      await taper(champ, horloge, `${CORRIGE} Merci`)
      expect(await ui.find({ type: 'Button', key: 'revenir' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: '9 mots' })).toBeDefined()

      await $.prompt.submit({ text: champ.text, origin: { kind: 'composer' }, wait: false })
      expect(await ui.find({ key: 'myconfig-lite' })).toBeUndefined()
      await ui.unmount()
    })

    test(`sans frappes remontées, le champ est relu chaque seconde (${surface})`, async ($, on) => {
      const { champ, horloge } = simuler(on)
      await demarrer($, surface)
      const ui = await $.ui.mount({ plugin: 'myconfig-lite', surface, ...bande })
      expect(await ui.find({ key: 'myconfig-lite' })).toBeUndefined()

      champ.text = 'bonjour le monde'
      await horloge.advance(1_100)
      expect(await ui.find({ type: 'Text', text: '3 mots' })).toBeDefined()
      await ui.unmount()
    })
  }

  test('la bande cède la place à un sondage', async ($, on) => {
    const { champ, horloge } = simuler(on)
    await demarrer($, 'terminal')
    await taper(champ, horloge, BRUT)
    const ui = await $.ui.mount({ plugin: 'myconfig-lite', surface: 'terminal', ...bande, props: { ...bande.props, hasSurvey: true } })
    expect(await ui.find({ key: 'myconfig-lite' })).toBeUndefined()
    await ui.unmount()
  })

  test('« ✓ Corriger » sans surlignage quand il est désactivé', async ($, on) => {
    const { champ, horloge } = simuler(on)
    await demarrer($)
    expect(await lite($, 'surlignage off')).toBe('MyConfig Lite : surlignage des corrections désactivé.')
    const ui = await $.ui.mount({ plugin: 'myconfig-lite', surface: 'desktop', ...bande })
    await taper(champ, horloge, BRUT)
    await ui.press({ key: 'corriger' })
    expect(champ.text).toBe(CORRIGE)
    expect(champ.decorations).toBeUndefined()
    await ui.unmount()
  })

  test('un champ vide ne part pas au modèle', async ($, on) => {
    const { consignes, toasts, champ, horloge } = simuler(on)
    await demarrer($)
    const ui = await $.ui.mount({ plugin: 'myconfig-lite', surface: 'desktop', ...bande })
    await taper(champ, horloge, BRUT)
    champ.text = '   '
    await ui.press({ key: 'corriger' })
    expect(consignes).toEqual([])
    expect(toasts).toEqual(['MyConfig Lite : le champ de saisie est vide.'])
    await ui.unmount()
  })

  test('une réponse coupée laisse le champ intact et le dit', async ($, on) => {
    const { champ, horloge, toasts } = simuler(on, { corriger: '<texte_final>\nJ’ai checké le fich' })
    await demarrer($)
    const ui = await $.ui.mount({ plugin: 'myconfig-lite', surface: 'desktop', ...bande })
    await taper(champ, horloge, BRUT)
    await ui.press({ key: 'corriger' })
    expect(champ.text).toBe(BRUT)
    expect(toasts).toEqual(['MyConfig Lite : la correction a échoué : réponse coupée, texte trop long. Rien n’est remplacé.'])
    expect(await ui.find({ type: 'Button', key: 'corriger' })).toBeDefined()
    await ui.unmount()
  })

  test('le champ modifié pendant l’appel n’est pas remplacé', async ($, on) => {
    const sim = simuler(on, {
      pendant: () => {
        sim.champ.text = `${BRUT} et vite`
      },
    })
    await demarrer($)
    const ui = await $.ui.mount({ plugin: 'myconfig-lite', surface: 'desktop', ...bande })
    await taper(sim.champ, sim.horloge, BRUT)
    await ui.press({ key: 'corriger' })
    expect(sim.champ.text).toBe(`${BRUT} et vite`)
    expect(sim.toasts).toEqual(['MyConfig Lite : le champ a changé pendant le travail. Rien n’est remplacé.'])
    await ui.unmount()
  })

  test('texte déjà correct, à une espace près : « Aucune faute », le champ ne bouge pas', async ($, on) => {
    const { champ, horloge } = simuler(on, { corriger: `<texte_final>${CORRIGE}</texte_final>` })
    await demarrer($)
    const ui = await $.ui.mount({ plugin: 'myconfig-lite', surface: 'desktop', ...bande })
    await taper(champ, horloge, `${CORRIGE} `)
    await ui.press({ key: 'corriger' })
    expect(champ.text).toBe(`${CORRIGE} `)
    expect(await ui.find({ type: 'Text', text: /^Aucune faute · / })).toBeDefined()
    expect((await ui.find({ type: 'Button', key: 'garder' }))?.props.label).toBe('OK')
    expect(await ui.find({ type: 'Button', key: 'revenir' })).toBeUndefined()

    // Le bilan reste malgré la relecture : le champ n'a pas changé.
    await horloge.advance(1_100)
    expect(await ui.find({ type: 'Text', text: /^Aucune faute · / })).toBeDefined()
    await ui.unmount()
  })

  test('« ↺ Revenir » n’écrase pas un texte tapé depuis', async ($, on) => {
    const { champ, horloge, toasts } = simuler(on)
    await demarrer($)
    const ui = await $.ui.mount({ plugin: 'myconfig-lite', surface: 'desktop', ...bande })
    await taper(champ, horloge, BRUT)
    await ui.press({ key: 'corriger' })
    champ.text = `${CORRIGE} Merci de regarder vite.`
    await ui.press({ key: 'revenir' })
    expect(champ.text).toBe(`${CORRIGE} Merci de regarder vite.`)
    expect(toasts).toEqual(['MyConfig Lite : le texte a changé depuis. Rien n’est rétabli.'])
    await ui.unmount()
  })

  test('une notification de tâche laisse le brouillon et le bilan', async ($, on) => {
    const { champ, horloge } = simuler(on)
    await demarrer($)
    const ui = await $.ui.mount({ plugin: 'myconfig-lite', surface: 'desktop', ...bande })
    await taper(champ, horloge, BRUT)
    await ui.press({ key: 'corriger' })
    await $.prompt.submit({ text: 'tâche finie', origin: { kind: 'task-notification' }, wait: false })
    expect(await ui.find({ type: 'Button', key: 'revenir' })).toBeDefined()
    await ui.unmount()
  })

  test('un autre mod qui remplit le champ : la bande suit aussitôt', async ($, on) => {
    const { horloge } = simuler(on)
    await demarrer($)
    const ui = await $.ui.mount({ plugin: 'myconfig-lite', surface: 'desktop', ...bande })
    await horloge.advance(1_100)
    expect(await ui.find({ key: 'myconfig-lite' })).toBeUndefined()
    await $.prompt.fill({ text: 'bonjour à tous', mode: 'replace', origin: { kind: 'plugin', name: 'autre' } })
    expect(await ui.find({ type: 'Text', text: '3 mots' })).toBeDefined()
    await ui.unmount()
  })
})

describe('la commande /lite', () => {
  test('sans argument : la version, les réglages et l’aide ; un réglage change et reste', async ($, on) => {
    simuler(on)
    expect(await lite($, '')).toMatch(/^MyConfig Lite 1\.0\.0\n✎ Améliorer : Sonnet\n✓ Corriger : Opus\n/)
    expect(await lite($, 'corriger sonnet')).toBe('MyConfig Lite : ✓ Corriger utilise Sonnet.')
    expect(await lite($, 'etat')).toContain('✓ Corriger : Sonnet')
  })
})
