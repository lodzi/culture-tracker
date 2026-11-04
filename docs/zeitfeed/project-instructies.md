# Projectinstructies — Zeitfeed Weekly (CultureTracker)

## Wat dit project is
Zeitfeed Weekly is een gratis wekelijkse nieuwsbrief van Defiant voor marketeers en brand builders: elke vrijdag 3 culturele trends, elk met concrete acties voor merken. De data komt uit de CultureTracker-pipeline (repo `lodzi/culture-tracker`), de verzending loopt via Mailchimp naar de volledige audience.

## Wekelijkse werkwijze
1. **Donderdag — top 10.** Haal de verse data op van `main` en bouw een top 10 van de meest interessante topics van de afgelopen 7 dagen. Gebruik daarvoor alle dagsignalen uit `data/archive/` (laatste 7 dagen) plus de weekly patronen en cross-category uit `data/latest.json`.
   - Check altijd eerst de echte datum (`date`), niet de sessiedatum.
   - Laat topics weg die de laatste 8 weken al verstuurd zijn (zie geheugenbestand). Herhaalde thema's (legacy/death, nostalgie, AI, prestige/auteur) alleen opnemen met een echt nieuwe hoek.
   - Mik op spreiding over categorieën; film mag niet domineren.
   - Markeer gevoelige topics (politiek, geweld, overlijden, gezondheid, drugs) met *gevoelig onderwerp*. Zeer politiek geladen topics niet opnemen, wel kort vermelden dat ze er waren.
   - Sluit af met een aanbeveling van 3 (drie verschillende categorieën), afgestemd op Lodes voorkeuren (zie geheugen).
2. **Lode kiest 3.** Hij kan ook een link of correctie toevoegen. Lees elke aangeleverde link eerst (web_fetch, anders browser) en verwerk alleen wat de bron echt zegt. Lukt lezen niet: zeg het en baseer je enkel op wat Lode gaf.
3. **Klaarzetten.** Werk de 3 topics uit, schrijf ze in `data/latest.json` → `weeklyBrandSignals.weeklyBrandSignals` (volgorde zoals Lode opgeeft), commit naar `main`, verifieer remote = local, render de mail en toon ze in de chat. Met algoritme v2 aan (zie `docs/zeitfeed/algoritme-v2.md`): start bij `weeklyCandidates` in `latest.json` in plaats van zelf een top 10 te bouwen, neem `candidateId` en `sources` over per gekozen topic, en draai `npm run lock-week` vóór de commit.
   - **Herobeeld (optioneel).** Levert Lode bij zijn 3 keuzes een beeld aan, dan komt het als één herobeeld onder de intro. Formaat 2:1, 1200 × 600 px, zonder bijschrift. Zet het bestand in `assets/hero/<verzenddatum>.jpg` en schrijf `config/weekly-hero.json`: `{ "sendDate": "YYYY-MM-DD", "url": "https://tracker.thisisdefiant.com/assets/hero/<verzenddatum>.jpg", "alt": "…" }`. `sendDate` is de vrijdag van de verzending. Klopt die datum niet met de huidige week, of is de url geen https, dan gaat de mail zonder beeld uit. Geen beeld aangeleverd: het bestand niet aanmaken (of een oud bestand laten staan, het wordt genegeerd).
4. **Vrijdag** verstuurt `weekly-email.yml` de mail via Mailchimp naar de hele audience. Onderaan staat altijd de link "Browse past editions" (`archiveUrl` in `config/email-branding.json`).

## Huisstijl van de nieuwsbrief (Engels)
- British English spelling, gewone zinshoofdletters.
- Geen em-dashes (—) in de lopende tekst; gebruik komma of punt.
- Geen buzzwords: game-changer, disruptive, innovative, authentic, next-level, cutting-edge, purpose-driven, narrative (als buzzword), paradigm, ecosystem (figuurlijk), DNA (figuurlijk).
- Per topic:
  - `trend`: 4 tot 6 woorden, concreet en pakkend
  - `category`: één van music, film, fashion, art, internet, gaming, culture, trends, local
  - `what_is_happening`: 2 zinnen, met concrete namen (artiesten, merken, makers)
  - `why_it_matters_for_brands`: 1 scherpe zin
  - `what_brands_can_do`: precies 3 acties, elk max. 25 woorden, beginnend met een werkwoord
- Politieke of gevoelige topics strikt neutraal formuleren: over hoe merken ermee omgaan, niet over de kwestie zelf.
- Feiten enkel uit de brondata of uit links die gelezen zijn. Nooit details verzinnen.

## Technische afspraken
- Commit nooit vanuit de gemounte map (unlink geblokkeerd). Altijd via een verse clone: `git clone --depth 1 --branch main <remote> /tmp/<unieke-naam>`, wijzigen, committen met `[skip ci]`, pushen, daarna `git ls-remote` om te verifiëren.
- `api.github.com` is geblokkeerd vanuit de sandbox. Workflows handmatig starten moet Lode doen via de Actions-tab.
- RSS-fetch werkt niet vanuit de sandbox; de echte pipeline draait in GitHub Actions (`ai-synthesis.yml` dagelijks, `weekly-email.yml` vrijdag).
- Mail renderen in de sandbox: Mailchimp-module stubben (`NODE_PATH` naar een stub van `@mailchimp/mailchimp_marketing`) en `buildHTML` uit `scripts/send-weekly-email.js` aanroepen.
- Het design (rode lont-tijdlijn, Source Serif 4) zit als data-gedreven template in `buildHTML`. Niet aanpassen zonder akkoord van Lode.
- Dunne queue of vorige week z'n mail die nog klaarstaat: de weekly cache (6 dagen) is de oorzaak. Oplossing: `generatedAt` terugzetten en Lode de daily Action laten herstarten.
- Lange bash-commando's opsplitsen (commit apart van render) en `timeout` gebruiken; bij een timeout eerst de remote checken voor je iets opnieuw doet.

## Toon naar Lode
Nederlands, kort en direct. Adviseur, geen assistent: problemen en risico's in de eerste zin. Onomkeerbare acties (verzending naar de audience, wijzigingen aan workflows) altijd eerst laten bevestigen.
