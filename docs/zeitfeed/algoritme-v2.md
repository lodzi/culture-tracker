# Algoritme v2 — Zeitfeed Weekly

Staat **uit** tot je de schakelaars omzet in `config/pipeline.json`. Met beide schakelaars uit draait de pipeline exact zoals voorheen.

## Wat er verandert

| Onderdeel | Voorheen | Met v2 |
|---|---|---|
| Kandidatenpool | Insights van vandaag + cross-category + weekpatronen | Alle dagelijkse insights van de laatste 7 dagen |
| Top 10 | Met de hand op donderdag | Pipeline maakt `weeklyCandidates` (top 10) op donderdag 06:00 UTC |
| Déjà vu | Geheugenbestand, met de hand bijgehouden | `data/sent.json`, thema's van de laatste 8 weken lager gescoord |
| Quota | Geen | Max. 2 per categorie (film ook 2), minstens 1 `lokaal` als de pool er een heeft |
| 6-daagse cache | Mailset bleef tot 6 dagen hangen | Weg. Regeneratie alleen op donderdag of met `force_weekly` |
| Bronnen | Alleen in de dagelijkse data | 2-3 links per kandidaat en per gekozen topic (`sources`), niet in de mail |
| Weekly-model | `claude-sonnet-4-6` | `models.weekly` (standaard `claude-opus-5-5`, valt terug op `models.weeklyFallback`) |
| Dagelijkse extractie | Globale top 10 clusters, 2+ bronnen verplicht | Max. 5 clusters per categorie (totaal 40), `lokaal` mag met 1 bron, `confidence` per insight |

## Schakelaars (`config/pipeline.json`)

- `weeklyV2`: kandidaten, sent.json-straf, quota, vergrendeling, stale-guard in het mailscript.
- `dailyPoolV2`: grotere dagelijkse pool (fetch + extractie). Heeft effect op wat de site toont: meer insights per dag, sommige met `confidence: "laag"`.

Aanbevolen volgorde: eerst beide aan op een dag zonder haast, laat 2 tot 3 dagen data opbouwen, en check de Thursday-run in de Actions-log.

## Donderdag-werkwijze

1. De daily Action van 06:00 UTC maakt `weeklyCandidates` (top 10) en zet een standaard-3 klaar (`selection: "auto"`, niet vergrendeld).
2. Lode kiest 3. Die worden uitgewerkt in `weeklyBrandSignals.weeklyBrandSignals`. Voeg per topic `candidateId` (bv. `c04`) en `sources` van de kandidaat toe.
3. `npm run lock-week` zet `sendDate`, `locked: true`, `selection: "manual"` en logt de 3 in `data/sent.json`. Daarna commit naar `main`.
4. Vrijdag verstuurt `weekly-email.yml`. Het mailscript weigert te versturen als de set bij een andere vrijdag hoort, of (met `weeklyV2` aan) geen `sendDate` heeft.

Een vergrendelde set wordt door de pipeline nooit overschreven, ook niet met `force_weekly`. Wil je opnieuw laten genereren: haal `locked` weg uit `latest.json`.

## Velden in `latest.json`

- `weeklyCandidates`: `generatedAt`, `sendDate`, `model`, `quota`, `skippedPolitical`, `candidates[]`.
  - Per kandidaat: `id`, `rank`, `trend`, `category`, `pitch`, `themes`, `sensitive`, `repeatOf`, `score`, `scoreBreakdown`, `repeatedThemes`, `sources[]`, `evidence[]`.
  - Score = sterkte (1-10 van het model) + 0,5 per dag gezien (max. 4) + 0,25 per bron (max. 4) + 1 voor cross-categorie − 1 bij enkel lage zekerheid − straf voor herhaalde thema's (max. 4, zware thema's ×1,5) − 3 als het model een herhaling meldt.
- `weeklyBrandSignals`: de bestaande velden plus `sendDate`, `locked`, `selection`, en per topic `candidateId` en `sources`.

## Grenzen

- Bronlinks laten je sneller controleren, ze voorkomen geen feitelijke fouten. De modellen krijgen titels en korte samenvattingen, geen artikeltekst. De prompts verbieden herkomst, nationaliteit en cijfers die niet in die tekst staan, maar controleer namen en herkomst altijd zelf.
- De thema-tags in `data/sent.json` voor augustus tot oktober zijn door Claude uit de titels afgeleid.
- Categorie `lokaal` heet in de data `lokaal` en in de mail `local`. Het script vertaalt dat.
