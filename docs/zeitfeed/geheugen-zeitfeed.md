# Geheugen — Zeitfeed Weekly

_Laatst bijgewerkt: 3 november 2026. Na elke verzending de nieuwe 3 topics bovenaan toevoegen._

## Verstuurde topics (nieuwste eerst)
Gebruik deze lijst om herhaling te vermijden: topics en thema's van de laatste 8 weken niet opnieuw voorstellen zonder echt nieuwe hoek.

| Verzending | Topics [categorie] |
|---|---|
| 30 okt | Hip-Hop's Curator Steps to the Front [music] · Design Looks Beyond the Human User [art] · Immersive Concert-Docs as Prestige Format [music] |
| 23 okt | AI Autonomy as Spectacle Over Engineering [internet] · Salvage Modernism: Upcycled Materials in Heritage Spaces [art] · Orchestra Collaborations Legitimise Genre Crossovers [music] |
| 16 okt | Immersive Brand Experiences via Temporary Installations [art] · Regional Festivals as Career-Launch Ecosystems [trends] · Safety-First Event Design as a Values Signal [music] |
| 9 okt | Pop-Culture Figures Claim Fine-Art Legitimacy [art] · Premium Streaming Wins Broadcast Rights from TV [internet] · Hardcore/Punk Revival Hits Mainstream Legitimacy (+ Stone Island) [music] |
| 2 okt | Belgian Artists Claim Global Indie Status (+ Julie Kegels) [music] · Brand Integration as the Base Touring Model [music] · Pre-Loved Luxury Gets Institutional Trust [fashion] |
| 25 sep | Retail-as-Aesthetic: Tech Design Colonises Fashion [fashion] · Underground Fashion Shows as Subcultural Legitimacy [culture] · Serial Killers as Girlboss Revisionism [trends] |
| 18 sep | iPhone Becomes a Legitimate Gaming Platform [gaming] · Artistic Accountability Goes Public (Macklemore/Ed Sheeran) [music] · Smart Home as Quiet Craft Aesthetic [art] |
| 11 sep | Hip-Hop as Institutional Reconciliation [music] · Participatory Documentary as Narrative Provocation [film] · Design as Anti-Disposability Philosophy [art] |
| 4 sep | True Crime Resolution as Cultural Reckoning [trends] · AI Licensing Normalises Artistic Consent [art] · Early-2010s Dance Becomes Hyperpop Grammar [music] |
| 28 aug | AI Slop Backlash Becomes a Brand Risk [internet] · Anime IP Redefines the Sneaker Category [fashion] · Creators Turn Director as Reputation Strategy [music] |
| 21 aug | Album Listening Parties as Immersive Retail [music] · Legends' Deaths Reshape Legacy Narratives [music] · Nostalgia Fatigue Sets In [film] |
| 14 aug | Nostalgia Licensing Spans Multiple Categories [fashion] · Digital Ownership Means Access, Not Property [gaming] · Hidden AI Erodes Corporate Trust [internet] |
| 7 aug | Platform War Against AI Content [internet] · Vulnerability Becomes Pop Authority [music] · Climate Messaging Turns Urgent [trends] |

Let op: dit is wat er op `main` klaargezet werd. Of elke mail effectief verstuurd is, kon niet altijd geverifieerd worden (28 aug vertrok pas 's avonds).

**Thema's die al vaak aan bod kwamen:** AI (6×), legacy/overlijden, nostalgie/franchise, immersive/experiential, design met duurzaamheid/ambacht, politieke stellingname van artiesten.

## Voorkeuren van Lode
- Kiest vrijwel altijd 3 verschillende categorieën.
- Terugkerende interesses: fashion/product-design, design en craft met een duurzaamheidshoek, muziek met een crossover- of geloofwaardigheidshoek, immersive/experiential, merkstrategie (merk als curator of filter).
- Wil concrete merk- of artiestenankers en voegt zelf vaak een link of voorbeeld toe (Stone Island, Sex Pistols).
- Corrigeert feiten scherp (bv. Matières Fécales is niet Belgisch): bij twijfel eerst checken.
- Wil topics die vers voelen; reageert slecht op déjà vu.
- Gevoelige onderwerpen kunnen, maar neutraal geframed en met een vlag.

## Open punten
- `reliable-friday-send` nog niet gemerged: verzending gebeurt nog op de oude cron (vrijdag 06:00 UTC, door de wintertijd nu 07:00 Brussel) en is niet betrouwbaar. De branch zet het vast op 10:30 Brussel, max. 1× per week.
- `test-topic-flow` (donderdag top-6 → keuze → vrijdag verzenden) nog niet live.
- Dagelijkse interne digest gebruikt nog het oude design.
- Overbodige Cowork-taak `culture-tracker-daily` stopzetten.
- Verbeterplan fase 1 (nog niet gestart): reliable-send mergen, log van verstuurde topics in de repo met lagere score voor recente thema's, bronlinks per topic, wekelijkse bronnencheck.
- Grootste inhoudelijke gaten: Belgische/lokale signalen bijna afwezig (1 in 10 weken), film oververtegenwoordigd (39% van de output), gemiddeld maar 2,9 trends per dag.
