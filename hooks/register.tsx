// MyConfig Lite : « ✎ Améliorer » réécrit le texte du champ de saisie en prompt clair,
// « ✓ Corriger » en corrige seulement les fautes. La bande (croquis 3 et 4 réunis) n'apparaît
// que lorsque le champ a du texte ; pendant l'appel au modèle, elle montre Annuler ; après, un
// bilan avec Garder et Revenir, et les mots corrigés surlignés dans le champ.
import type { EngineInterface, PromptDecoration, Register, RenderElement, RenderInput } from 'claude-code'

import type { Plage, Reglages, Resultat, Travail } from '../types'
import { CONSIGNE_AMELIORER, CONSIGNE_CORRIGER } from './consignes'
import {
  appliquer,
  bilan,
  comparer,
  compterMots,
  completer,
  delaiMax,
  enCours,
  enveloppe,
  estCommande,
  inchange,
  jetonsMax,
  libelleMots,
  memesReglages,
  nettoyer,
  nomTravail,
  raisonEchec,
  raisonRefus,
  resume,
  USAGE,
} from './correction'

type Bande = RenderInput<'AbovePrompt'>

// ── État ──────────────────────────────────────────────────────────────────────
// Chaque valeur de $.state est déclarée dans types/index.d.ts.

const mots = { plugin: 'myconfig-lite', key: 'mots' } as const
const travail = { plugin: 'myconfig-lite', key: 'travail' } as const
const resultat = { plugin: 'myconfig-lite', key: 'resultat' } as const
const reglages = { plugin: 'myconfig-lite', key: 'reglages' } as const

// Les réglages dans $.store, partagé par toutes les sessions et qui survit à « /clear ».
const CLE_REGLAGES = 'reglages'

const NOM = 'MyConfig Lite'
const VERSION = '1.0.0'

// Sans hook `prompt.edit` (une surface qui ne remonte pas les frappes), le champ est relu
// à ce rythme pour savoir s'il a du texte.
const RELECTURE_MS = 1000

// Le verrou de l'action en cours, pris avant le premier await (deux pressions rapprochées ne
// lancent qu'un appel), et le moyen de l'annuler. Un rechargement du mod le remet à zéro.
let arret: AbortController | null = null
// Vrai dès qu'une frappe est remontée par `prompt.edit` : la relecture n'est plus utile.
let frappesSuivies = false
let relecture: { cancel: () => unknown } | null = null

// ── Réglages ──────────────────────────────────────────────────────────────────

// Les réglages du store, la source partagée ; $.state en garde une copie pour le dessin.
async function lireReglages($: EngineInterface): Promise<Reglages> {
  const r = completer(await $.store.get(CLE_REGLAGES))
  const { value } = await $.state.get(reglages)
  if (!value || !memesReglages(value, r)) {
    await $.state.set(reglages, r)
  }
  return r
}

async function ecrireReglages($: EngineInterface, r: Reglages) {
  await $.store.set(CLE_REGLAGES, r)
  await $.state.set(reglages, r)
}

// ── Le champ de saisie ────────────────────────────────────────────────────────

// Une commande (« /… ») ou le mode bash (« ! ») compte pour zéro mot : pas de bande.
const motsDuChamp = (texte: string) => (estCommande(texte) ? 0 : compterMots(texte))

const decorer = (plages: Plage[]): PromptDecoration[] => plages.map(p => ({ ...p, backgroundColor: 'diffAddedWord' }))

// Le champ a changé : le nombre de mots suit, et le bilan disparaît dès que le texte n'est plus
// celui que le mod a mis. Renvoie le bilan encore valable, ou rien.
async function suivreChamp($: EngineInterface, texte: string): Promise<Resultat | null> {
  const n = motsDuChamp(texte)
  const { value: avant = 0 } = await $.state.get(mots)
  if (avant !== n) {
    await $.state.set(mots, n)
  }
  const { value: r = null } = await $.state.get(resultat)
  if (r !== null && texte !== r.apres) {
    await $.state.set(resultat, null)
    return null
  }
  return r
}

// La relecture : lit les versions avant le champ, pour qu'un remplissage ou un bilan écrit
// entre-temps fasse échouer l'écriture périmée.
async function relire($: EngineInterface) {
  const m0 = await $.state.get(mots)
  const r0 = await $.state.get(resultat)
  const { text } = await $.prompt.read()
  const n = motsDuChamp(text)
  if ((m0.value ?? 0) !== n) {
    await $.state.set(mots, n, { ifVersion: m0.version })
  }
  if (r0.value && text !== r0.value.apres) {
    await $.state.set(resultat, null, { ifVersion: r0.version })
  }
}

function signaler($: EngineInterface, message: string | undefined) {
  if (message !== undefined) {
    $.ui.toast(`${NOM} : ${message}`)
  }
}

// Un bouton : son message, ou celui d'une erreur imprévue, va dans un toast.
async function presser($: EngineInterface, action: () => Promise<string | undefined>) {
  try {
    signaler($, await action())
  } catch (x) {
    signaler($, `erreur imprévue (${x instanceof Error ? x.message : String(x)}).`)
  }
}

// ── Les actions ───────────────────────────────────────────────────────────────

// Envoie le texte du champ au modèle et met la réponse à sa place. Renvoie un message d'erreur,
// ou rien.
async function agir($: EngineInterface, quoi: Travail): Promise<string | undefined> {
  if (arret !== null) {
    return undefined
  }
  const controle = new AbortController()
  arret = controle
  try {
    const { text: avant } = await $.prompt.read()
    if (avant.trim() === '') {
      await $.state.set(mots, 0)
      return 'le champ de saisie est vide.'
    }
    if (estCommande(avant)) {
      return 'les commandes « / » et le mode bash « ! » ne sont pas réécrits.'
    }
    const r = await lireReglages($)
    const modele = r[quoi]
    await $.state.set(travail, quoi)

    const maxTokens = jetonsMax(avant)
    const timeoutMs = delaiMax(avant)
    const debut = await $.clock.now()
    let reponse
    try {
      reponse = await $.model.complete(
        {
          model: modele,
          system: quoi === 'ameliorer' ? CONSIGNE_AMELIORER : CONSIGNE_CORRIGER,
          prompt: enveloppe(avant),
          maxTokens,
          timeoutMs,
        },
        { signal: controle.signal },
      )
    } catch (x) {
      return `${nomTravail(quoi)} a échoué (${x instanceof Error ? x.message : 'requête refusée'}).`
    }
    if (controle.signal.aborted) {
      return undefined
    }
    if (!reponse.isAnswered) {
      return `${nomTravail(quoi)} a échoué (${raisonEchec(reponse, timeoutMs)}).`
    }
    const ms = (await $.clock.now()) - debut

    // Une réponse coupée par la limite de longueur ne remplace jamais le texte.
    const propre = nettoyer(reponse.text, avant)
    if (propre === null || reponse.usage.output_tokens >= maxTokens) {
      return `${nomTravail(quoi)} a échoué : réponse coupée, texte trop long. Rien n’est remplacé.`
    }
    if (propre === '') {
      return `${nomTravail(quoi)} a échoué (réponse vide).`
    }
    if (estCommande(propre)) {
      return `${nomTravail(quoi)} commencerait par une commande. Rien n’est remplacé.`
    }

    // Le champ a pu changer pendant l'appel : on ne remplace que le texte envoyé.
    const { text: maintenant } = await $.prompt.read()
    if (maintenant !== avant) {
      return 'le champ a changé pendant le travail. Rien n’est remplacé.'
    }
    if (controle.signal.aborted) {
      return undefined
    }

    const base = { travail: quoi, avant, motsAvant: compterMots(avant), ms, modele }
    // Rien à changer : le champ reste tel quel, curseur compris.
    if (inchange({ avant, apres: propre })) {
      await $.state.set(resultat, { ...base, apres: avant, plages: [], changements: 0, motsApres: base.motsAvant })
      return undefined
    }

    const { changements, plages } = comparer(avant, propre)
    const surligne = quoi === 'corriger' && r.surlignage ? plages : []
    const rempli = await $.prompt.fill({
      text: propre,
      mode: 'replace',
      ...(surligne.length > 0 ? { decorations: decorer(surligne) } : {}),
    })
    if (!rempli.isFilled) {
      return `impossible de remplacer le texte (${raisonRefus(rempli.refusal)}).`
    }
    // Le bilan suit ce que le champ a vraiment pris (il retire les caractères invisibles).
    const apres = typeof rempli.text === 'string' && rempli.text !== '' ? rempli.text : propre
    const fait: Resultat = {
      ...base,
      apres,
      plages: apres === propre ? surligne : [],
      changements,
      motsApres: compterMots(apres),
    }
    await $.state.set(mots, motsDuChamp(apres))
    await $.state.set(resultat, fait)
    return undefined
  } finally {
    if (arret === controle) {
      arret = null
      await $.state.set(travail, null)
    }
  }
}

// Revenir : le texte d'avant l'action reprend sa place, si le champ n'a pas changé depuis.
async function revenir($: EngineInterface): Promise<string | undefined> {
  const { value: r = null } = await $.state.get(resultat)
  if (r === null) {
    return undefined
  }
  const { text } = await $.prompt.read()
  if (text !== r.apres) {
    await $.state.set(resultat, null)
    return 'le texte a changé depuis. Rien n’est rétabli.'
  }
  const rempli = await $.prompt.fill({ text: r.avant, mode: 'replace' })
  if (!rempli.isFilled) {
    return `impossible de rétablir le texte (${raisonRefus(rempli.refusal)}).`
  }
  await $.state.set(resultat, null)
  await $.state.set(mots, motsDuChamp(r.avant))
  return undefined
}

// Garder : le texte reste, sans surlignage, et la bande revient aux boutons.
async function garder($: EngineInterface): Promise<string | undefined> {
  const { value: r = null } = await $.state.get(resultat)
  if (r === null) {
    return undefined
  }
  await $.state.set(resultat, null)
  if (r.plages.length > 0) {
    const { text } = await $.prompt.read()
    if (text === r.apres) {
      await $.prompt.fill({ text, mode: 'replace' })
    }
  }
  return undefined
}

// Annuler : coupe l'appel en cours. Sans appel (un état resté d'un ancien chargement), la bande
// revient aux boutons.
async function annuler($: EngineInterface) {
  if (arret !== null) {
    arret.abort()
  } else {
    await $.state.set(travail, null)
  }
}

// ── La bande ──────────────────────────────────────────────────────────────────

async function ligne($: EngineInterface, e: Bande): Promise<RenderElement | undefined> {
  const { value: quoi = null } = await $.state.get(travail)
  const { value: fait = null } = await $.state.get(resultat)
  const { value: n = 0 } = await $.state.get(mots)
  const { Box, Button, Text } = $.ui.resolve(e)

  if (quoi !== null) {
    const { value: copie = null } = await $.state.get(reglages)
    const r = copie ?? completer(await $.store.get(CLE_REGLAGES))
    return (
      <Box key="myconfig-lite" flexDirection="row" gap={1} alignItems="center" width="100%">
        <Text color="claude">✦</Text>
        <Text dimColor wrap="truncate-end">
          {enCours(quoi, r[quoi])}
        </Text>
        <Box key="espace" flexGrow={1} />
        <Button key="annuler" label="Annuler" onPress={() => annuler($)} />
      </Box>
    )
  }

  if (fait !== null) {
    const rien = inchange(fait)
    return (
      <Box key="myconfig-lite" flexDirection="row" gap={1} alignItems="center" width="100%">
        <Text color="success">✓</Text>
        <Text wrap="truncate-end">{bilan(fait)}</Text>
        <Box key="espace" flexGrow={1} />
        <Button key="garder" label={rien ? 'OK' : 'Garder'} hotkey="g" onPress={() => presser($, () => garder($))} />
        {rien ? null : <Button key="revenir" label="↺ Revenir" hotkey="r" onPress={() => presser($, () => revenir($))} />}
      </Box>
    )
  }

  // Champ vide (ou une commande) : la bande ne montre rien.
  if (n === 0) {
    return undefined
  }
  return (
    <Box key="myconfig-lite" flexDirection="row" gap={1} alignItems="center" width="100%">
      <Text dimColor>{libelleMots(n)}</Text>
      <Box key="espace" flexGrow={1} />
      <Button
        key="ameliorer"
        label="✎ Améliorer"
        variant="primary"
        hotkey="a"
        onPress={() => presser($, () => agir($, 'ameliorer'))}
      />
      <Button key="corriger" label="✓ Corriger" hotkey="c" onPress={() => presser($, () => agir($, 'corriger'))} />
    </Box>
  )
}

// ── Les hooks ─────────────────────────────────────────────────────────────────

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'lite',
      description: 'Réglages de MyConfig Lite : le modèle de chaque bouton, le surlignage des corrections',
      argumentHint: '[modele <haiku|sonnet|opus> | ameliorer <modèle> | corriger <modèle> | surlignage on|off]',
    })
    // Un chargement neuf n'a aucun appel en cours, même si $.state en garde la trace.
    await $.state.set(travail, null)
    await lireReglages($)
    // Tant qu'aucune frappe n'est remontée, le champ est relu chaque seconde.
    relecture?.cancel()
    relecture = $.clock.every(RELECTURE_MS, () => {
      if (frappesSuivies) {
        relecture?.cancel()
        relecture = null
        return
      }
      void relire($).catch(() => undefined)
    })
    return next(e)
  })

  on('command.run', { command: 'lite' }, async ($, e) => {
    const args = e.args.trim()
    const r = await lireReglages($)
    if (args === '' || /^(aide|help|\?|[ée]tat)$/i.test(args)) {
      return { text: `${NOM} ${VERSION}\n${resume(r)}\n\n${USAGE}` }
    }
    const changement = appliquer(r, args)
    if ('erreur' in changement) {
      return { text: changement.erreur }
    }
    await ecrireReglages($, changement.reglages)
    return { text: changement.message }
  })

  // Chaque frappe : le nombre de mots suit, le bilan disparaît si le texte change, et le
  // surlignage des corrections reste tant que le texte est celui que le mod a mis (un simple
  // déplacement du curseur est aussi une édition, qui remplace les décorations).
  on('prompt.edit', async ($, e, next) => {
    const r = await next(e)
    frappesSuivies = true
    const fait = await suivreChamp($, r.text)
    if (fait !== null && fait.plages.length > 0 && r.text === fait.apres) {
      return { ...r, decorations: [...(r.decorations ?? []), ...decorer(fait.plages)] }
    }
    return r
  }).catch(($, e, next) => next(e))

  // Un autre mod remplit le champ : la bande suit (le mod ne voit pas ses propres remplissages).
  on('prompt.fill', async ($, e, next) => {
    const r = await next(e)
    if (r.isFilled) {
      const { text } = await $.prompt.read()
      await suivreChamp($, text)
    }
    return r
  }).catch(($, e, next) => next(e))

  // Prompt envoyé depuis le champ : il est vide, plus rien à garder ni à rétablir. Les autres
  // envois (notification de tâche, autre session, mod) laissent le brouillon en place.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer') {
      await $.state.set(resultat, null)
      await $.state.set(mots, 0)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const dessous = await next(e)
    if (e.props.hasSurvey) {
      return dessous
    }
    const bande = await ligne($, e)
    if (bande === undefined) {
      return dessous
    }
    if (dessous === undefined || dessous === null) {
      return bande
    }
    const { Box } = $.ui.resolve(e)
    return (
      <Box key="myconfig-lite-pile" flexDirection="column">
        {dessous}
        {bande}
      </Box>
    )
  })
}
