// errungenschaftenLogik.js -- Reine Erkennungsfunktionen fuer das Errungenschaften-System.
// Importiert bewusst NUR den Katalog (keine Mongo-/NextControl-Abhaengigkeit), damit dieses
// Modul gefahrlos von Testskripten importiert werden kann (Testbarkeitsregel:
// controller/plugins/*.js und nextcontrol.js duerfen von Testskripten niemals importiert werden).
// Der I/O-Teil (Mongo lesen/schreiben, Chat, Gaming-Log) lebt in controller/plugins/errungenschaften.js.

/**
 * Schwellenwerte fuer alle grind-basierten Abzeichen. Im Testmodus stark verkuerzt, damit sich
 * jedes Abzeichen in wenigen Minuten am Trainingsserver verifizieren laesst -- NIE in Produktion
 * setzen (ENV ERRUNGENSCHAFTEN_TEST=true).
 */
export function schwellen(testModus = false) {
    return testModus
        ? {
              marathonMinuten: 3,
              alleinMinuten: 2,
              finishesKlein: 3,
              finishesGross: 6,
              checkpoints: 20,
              spielzeit24hMinuten: 10,
              spielzeit100hMinuten: 20,
              verbindungen: 3,
              karmaBewertungen: 3,
              wimpernschlagMs: 5,
              kellerkindMinuten: 5,
              rueckkehrerMinuten: 2,
              willkommenMindestanzahl: 1,
              revancheFensterMs: 60 * 1000,
          }
        : {
              marathonMinuten: 180,
              alleinMinuten: 60,
              finishesKlein: 100,
              finishesGross: 1000,
              checkpoints: 10000,
              spielzeit24hMinuten: 1440,
              spielzeit100hMinuten: 6000,
              verbindungen: 100,
              karmaBewertungen: 10,
              wimpernschlagMs: 5,
              kellerkindMinuten: 360,
              rueckkehrerMinuten: 45 * 24 * 60,
              willkommenMindestanzahl: 3,
              revancheFensterMs: 15 * 60 * 1000,
          };
}

/** Fixe (nicht testmodus-abhaengige) Schwellen fuer monatshistorien-basierte Abzeichen -- werden
 * ausschliesslich per Fixture-Tests verifiziert (siehe scripts/test-errungenschaften.js), ein
 * Live-Zeitraffer ergibt fuer Monatsdaten keinen Sinn. */
export const DAUERBRENNER_MINDEST_STREAK = 6;
export const EWIGER_ZWEITER_MINDEST_ANZAHL = 3;

/** Lokale Stunde (0-4 Uhr) fuer "Nachtschwärmer". Im Testmodus immer wahr. */
export function istNachtstunde(datum, testModus = false) {
    if (testModus) return true;
    const stunde = datum.getHours();
    return stunde >= 0 && stunde < 4;
}

/** Letzter Kalendertag des Monats fuer "Last-Minute-Held". Im Testmodus immer wahr. */
export function istLetzterTagDesMonats(datum, testModus = false) {
    if (testModus) return true;
    const morgen = new Date(datum.getFullYear(), datum.getMonth(), datum.getDate() + 1);
    return morgen.getMonth() !== datum.getMonth();
}

/** "YYYY-MM" des Kalendermonats vor dem uebergebenen Monat. */
export function vorherigerMonat(monat) {
    const [jahr, monatsNr] = monat.split('-').map(Number);
    const gesamtIndexVorher = jahr * 12 + (monatsNr - 1) - 1; // 0-basiert, dann -1
    const vJahr = Math.floor(gesamtIndexVorher / 12);
    const vMonat = (gesamtIndexVorher % 12) + 1;
    return `${vJahr}-${String(vMonat).padStart(2, '0')}`;
}

/** Sieger einer (bereits absteigend nach Punkten sortierten) Rangliste, oder null bei leerem/punktlosem Monat. */
export function ermittleSieger(eintraege) {
    const erster = eintraege?.[0];
    return erster && erster.punkte > 0 ? erster.login : null;
}

/** Logins der Top 3 einer Rangliste (nur Eintraege mit Punkten > 0) fuer "Podestfahrer". */
export function ermittlePodest(eintraege) {
    return (eintraege ?? []).slice(0, 3).filter((e) => e.punkte > 0).map((e) => e.login);
}

/**
 * Hattrick: derselbe Spieler hat den aktuellen Monat UND die zwei direkt davorliegenden
 * Kalendermonate gewonnen.
 * @param {string} monat "YYYY-MM" des gerade abgeschlossenen Monats
 * @param {Map<string,string|null>} siegerProMonat monat -> Login des Monatssiegers (oder null)
 * @returns {string|null} Login bei Hattrick, sonst null
 */
export function pruefeHattrick(monat, siegerProMonat) {
    const sieger = siegerProMonat.get(monat);
    if (!sieger) return null;
    const vorMonat = vorherigerMonat(monat);
    const vorVorMonat = vorherigerMonat(vorMonat);
    if (siegerProMonat.get(vorMonat) === sieger && siegerProMonat.get(vorVorMonat) === sieger) return sieger;
    return null;
}

/**
 * Durchmarsch: ein einzelner Spieler haelt am Monatsende auf JEDER Strecke des Monats Platz 1.
 * @param {Array<{login:string,time:number,map:string}>} archivRecordsDesMonats
 * @param {number} anzahlMapsDesMonats Gesamtzahl der Strecken des Monats (auch ohne Records!)
 * @returns {string|null}
 */
export function ermittleDurchmarschSieger(archivRecordsDesMonats, anzahlMapsDesMonats) {
    if (!anzahlMapsDesMonats) return null;
    const proMap = new Map();
    for (const r of archivRecordsDesMonats) {
        if (!proMap.has(r.map)) proMap.set(r.map, []);
        proMap.get(r.map).push(r);
    }
    if (proMap.size !== anzahlMapsDesMonats) return null; // mind. eine Strecke ganz ohne Zeiten -> kein Durchmarsch

    const sieger = new Set();
    for (const records of proMap.values()) {
        const bester = records.reduce((a, b) => (a.time <= b.time ? a : b));
        sieger.add(bester.login);
    }
    return sieger.size === 1 ? [...sieger][0] : null;
}

/**
 * Live-korrigierte Statistik-Schwellen (Finishes/Checkpoints/Spielzeit/Verbindungen).
 * @param {{finishes?:number,checkpoints?:number,timePlayed?:number,connections?:number}} statsDoc
 * @param {number} laufendeSessionMinuten Minuten der aktuell laufenden Session (noch nicht in timePlayed gespeichert)
 * @param {ReturnType<typeof schwellen>} schwellenWerte
 * @returns {string[]} IDs der neu erreichten Abzeichen
 */
export function pruefeStatsSchwellen(statsDoc, laufendeSessionMinuten, schwellenWerte) {
    const finishes = statsDoc?.finishes ?? 0;
    const checkpoints = statsDoc?.checkpoints ?? 0;
    const connections = statsDoc?.connections ?? 0;
    const effektiveSpielzeit = (statsDoc?.timePlayed ?? 0) + (laufendeSessionMinuten ?? 0);

    const erreicht = [];
    if (finishes >= schwellenWerte.finishesKlein) erreicht.push('serienfinisher');
    if (finishes >= schwellenWerte.finishesGross) erreicht.push('ziellinienlegende');
    if (checkpoints >= schwellenWerte.checkpoints) erreicht.push('checkpointsammler');
    if (effektiveSpielzeit >= schwellenWerte.spielzeit24hMinuten) erreicht.push('rundumdieuhr');
    if (effektiveSpielzeit >= schwellenWerte.spielzeit100hMinuten) erreicht.push('inventar');
    if (connections >= schwellenWerte.verbindungen) erreicht.push('stammgast');
    return erreicht;
}

/** Streckenkritiker: mindestens N verschiedene Strecken bewertet. */
export function pruefeKarmaSchwelle(anzahlBewerteterStrecken, schwellenWerte) {
    return (anzahlBewerteterStrecken ?? 0) >= schwellenWerte.karmaBewertungen;
}

/**
 * Baut je Strecke den aktuellen Fuehrenden + Vorsprung auf Platz 2 (fuer "Platzhirsch"/
 * "Wimpernschlag"/"Last-Minute-Held" -- vermeidet die Race Condition mit localRecords.js,
 * die bei einer direkten onWaypoint-Abfrage der records-Collection entstehen wuerde).
 * @param {Array<{login:string,time:number,map:string}>} records
 * @returns {Map<string,{login:string,time:number,gapMs:number|null}>}
 */
export function ermittleFuehrendeProMap(records) {
    const proMap = new Map();
    for (const r of records) {
        if (!proMap.has(r.map)) proMap.set(r.map, []);
        proMap.get(r.map).push(r);
    }
    const fuehrende = new Map();
    for (const [uid, mapRecords] of proMap) {
        const sortiert = [...mapRecords].sort((a, b) => a.time - b.time);
        const [erster, zweiter] = sortiert;
        fuehrende.set(uid, { login: erster.login, time: erster.time, gapMs: zweiter ? zweiter.time - erster.time : null });
    }
    return fuehrende;
}

/**
 * Vergleicht zwei Fuehrende-Snapshots (siehe ermittleFuehrendeProMap) und liefert alle neu
 * ausgeloesten Fuehrungs-Ereignisse. Platzhirsch/Last-Minute-Held haengen an einem echten
 * Fuehrungswechsel (neuer Login oder neue eigene Zeit des Fuehrenden). Wimpernschlag wird davon
 * BEWUSST getrennt geprueft: der Abstand zu Platz 2 kann sich auch aendern, wenn NUR Platz 2 eine
 * neue Zeit faehrt, waehrend der Fuehrende unveraendert bleibt -- das darf das Abzeichen nicht
 * verpassen (frueher haengte der Gap-Check faelschlich am Fuehrungswechsel-Zweig).
 * @param {Map<string,{login:string,time:number,gapMs:number|null}>} altSnapshot
 * @param {Map<string,{login:string,time:number,gapMs:number|null}>} neuSnapshot
 * @param {ReturnType<typeof schwellen>} schwellenWerte
 * @param {{istLetzterTag:boolean}} kontext
 * @returns {Array<{login:string, errungenschaft:string}>}
 */
export function pruefeFuehrungswechsel(altSnapshot, neuSnapshot, schwellenWerte, kontext) {
    const ereignisse = [];
    for (const [uid, neu] of neuSnapshot) {
        const alt = altSnapshot.get(uid);
        const hatSichGeaendert = !alt || alt.login !== neu.login || alt.time !== neu.time;

        if (hatSichGeaendert) {
            ereignisse.push({ login: neu.login, errungenschaft: 'platzhirsch' });
            if (kontext?.istLetzterTag) {
                ereignisse.push({ login: neu.login, errungenschaft: 'lastminutehero' });
            }
        }

        // Nur als NEUES Ereignis werten, wenn der Abstand gerade jetzt unter die Schwelle
        // gerutscht ist -- sonst wuerde jeder Tick erneut (harmlos dank idempotentem vergeben(),
        // aber unnoetig) ein Ereignis erzeugen, solange der knappe Vorsprung bestehen bleibt.
        const warSchonUnterschwelle = alt?.gapMs != null && alt.gapMs < schwellenWerte.wimpernschlagMs;
        if (neu.gapMs !== null && neu.gapMs < schwellenWerte.wimpernschlagMs && !warSchonUnterschwelle) {
            ereignisse.push({ login: neu.login, errungenschaft: 'wimpernschlag' });
        }
    }
    return ereignisse;
}

/**
 * Sofortige Revanche: ein Spieler verliert die Fuehrung auf einer Strecke an einen anderen
 * Spieler und erobert sie innerhalb eines kurzen Zeitfensters zurueck. Nutzt denselben
 * Fuehrende-Snapshot-Vergleich wie pruefeFuehrungswechsel(), haelt aber zusaetzlich eine kleine
 * Verlust-Historie je Map (wer hat die Fuehrung zuletzt an wen verloren, wann), damit ein
 * Rueck-Wechsel erkennbar ist. Bewusst getrennt von pruefeFuehrungswechsel() gehalten (eigene
 * Historie noetig) statt beide Funktionen zu verschmelzen -- haelt beide klein und einzeln testbar.
 * @param {Map<string,{login:string,time:number,gapMs:number|null}>} altSnapshot
 * @param {Map<string,{login:string,time:number,gapMs:number|null}>} neuSnapshot
 * @param {Map<string,{vorherigerFuehrender:string, verlorenAmMs:number}>} verlustHistorie Map-UID -> letzter Fuehrungsverlust
 * @param {number} jetztMs
 * @param {ReturnType<typeof schwellen>} schwellenWerte
 * @returns {{ereignisse: Array<{login:string, errungenschaft:string}>, neueHistorie: Map<string,{vorherigerFuehrender:string, verlorenAmMs:number}>}}
 */
export function pruefeSofortigeRevanche(altSnapshot, neuSnapshot, verlustHistorie, jetztMs, schwellenWerte) {
    const ereignisse = [];
    const neueHistorie = new Map(verlustHistorie);
    for (const [uid, neu] of neuSnapshot) {
        const alt = altSnapshot.get(uid);
        if (!alt || alt.login === neu.login) continue; // kein Fuehrungswechsel auf dieser Map

        const bisherigerVerlust = neueHistorie.get(uid);
        if (
            bisherigerVerlust &&
            bisherigerVerlust.vorherigerFuehrender === neu.login &&
            jetztMs - bisherigerVerlust.verlorenAmMs <= schwellenWerte.revancheFensterMs
        ) {
            ereignisse.push({ login: neu.login, errungenschaft: 'sofortigerevanche' });
        }
        neueHistorie.set(uid, { vorherigerFuehrender: alt.login, verlorenAmMs: jetztMs });
    }
    return { ereignisse, neueHistorie };
}

/** Nur "echte" YYYY-MM-Monate (keine season:-Legacy-Token, siehe kennzahlen.js nurEchteMonateSortiert). */
function istEchterMonat(monat) {
    return /^\d{4}-\d{2}$/.test(monat);
}

/** Meteorologische Saison eines "YYYY-MM"-Monats: 0=Winter(Dez-Feb) 1=Fruehling(Mrz-Mai) 2=Sommer(Jun-Aug) 3=Herbst(Sep-Nov). */
function saisonVonMonat(monat) {
    const monatsNr = Number(monat.slice(5, 7));
    if (monatsNr === 12 || monatsNr <= 2) return 0;
    if (monatsNr <= 5) return 1;
    if (monatsNr <= 8) return 2;
    return 3;
}

/**
 * Vier Jahreszeiten: mindestens ein aktiver (punkte>0) Monat in jeder der 4 Jahreszeiten
 * INNERHALB DESSELBEN Kalenderjahres (Dezember zaehlt bewusst vereinfacht zum Winter des
 * eigenen Jahres, kein Jahreswechsel-Sonderfall -- "ein Kalenderjahr" reicht als Rahmen).
 * @param {Array<{monat:string, eintraege:Array<{login:string,punkte:number}>}>} alleMonate
 * @returns {Set<string>} Logins, die das Abzeichen erreicht haben
 */
export function ermittleVierJahreszeiten(alleMonate) {
    const proSpieler = new Map(); // login -> Map<jahr, Set<saison>>
    for (const m of alleMonate) {
        if (!istEchterMonat(m.monat)) continue;
        const jahr = m.monat.slice(0, 4);
        const saison = saisonVonMonat(m.monat);
        for (const e of m.eintraege ?? []) {
            if (e.punkte <= 0) continue;
            if (!proSpieler.has(e.login)) proSpieler.set(e.login, new Map());
            const proJahr = proSpieler.get(e.login);
            if (!proJahr.has(jahr)) proJahr.set(jahr, new Set());
            proJahr.get(jahr).add(saison);
        }
    }
    const erreicht = new Set();
    for (const [login, proJahr] of proSpieler) {
        for (const saisonen of proJahr.values()) {
            if (saisonen.size === 4) { erreicht.add(login); break; }
        }
    }
    return erreicht;
}

/**
 * Jahresfahrer: in allen 12 Kalendermonaten eines Jahres aktiv (punkte>0) gewesen.
 * @param {Array<{monat:string, eintraege:Array<{login:string,punkte:number}>}>} alleMonate
 * @returns {Set<string>}
 */
export function ermittleJahresfahrer(alleMonate) {
    const proSpieler = new Map(); // login -> Map<jahr, Set<monatsNr>>
    for (const m of alleMonate) {
        if (!istEchterMonat(m.monat)) continue;
        const jahr = m.monat.slice(0, 4);
        const monatsNr = Number(m.monat.slice(5, 7));
        for (const e of m.eintraege ?? []) {
            if (e.punkte <= 0) continue;
            if (!proSpieler.has(e.login)) proSpieler.set(e.login, new Map());
            const proJahr = proSpieler.get(e.login);
            if (!proJahr.has(jahr)) proJahr.set(jahr, new Set());
            proJahr.get(jahr).add(monatsNr);
        }
    }
    const erreicht = new Set();
    for (const [login, proJahr] of proSpieler) {
        for (const monate of proJahr.values()) {
            if (monate.size === 12) { erreicht.add(login); break; }
        }
    }
    return erreicht;
}

/**
 * Dauerbrenner: mindestens `mindestStreak` aufeinanderfolgende (echte, chronologisch sortierte)
 * Monate mit Aktivitaet (punkte>0) -- Streak-Ende/Anfang duerfen ueber Kalenderjahre hinausgehen.
 * @param {Array<{monat:string, eintraege:Array<{login:string,punkte:number}>}>} alleMonateChronologisch bereits chronologisch sortiert, nur echte Monate
 * @param {number} mindestStreak
 * @returns {Set<string>}
 */
export function ermittleDauerbrenner(alleMonateChronologisch, mindestStreak) {
    const alleLogins = new Set();
    for (const m of alleMonateChronologisch) {
        for (const e of m.eintraege ?? []) if (e.punkte > 0) alleLogins.add(e.login);
    }

    const erreicht = new Set();
    for (const login of alleLogins) {
        let streak = 0;
        for (const m of alleMonateChronologisch) {
            const aktiv = (m.eintraege ?? []).some((e) => e.login === login && e.punkte > 0);
            streak = aktiv ? streak + 1 : 0;
            if (streak >= mindestStreak) { erreicht.add(login); break; }
        }
    }
    return erreicht;
}

/**
 * Ewiger Zweiter: mindestens `mindestAnzahlRang2` Monate auf Rang 2 der Punktewertung beendet,
 * aber noch NIE Rang 1 (Monatssieger) erreicht -- ueber die komplette uebergebene Historie.
 * @param {Array<{monat:string, eintraege:Array<{login:string,punkte:number}>}>} alleMonate
 * @param {number} mindestAnzahlRang2
 * @returns {Set<string>}
 */
export function ermittleEwigerZweiter(alleMonate, mindestAnzahlRang2) {
    const rang1ProSpieler = new Set();
    const rang2AnzahlProSpieler = new Map();
    for (const m of alleMonate) {
        if (!istEchterMonat(m.monat)) continue;
        const eintraege = (m.eintraege ?? []).filter((e) => e.punkte > 0);
        if (eintraege[0]) rang1ProSpieler.add(eintraege[0].login);
        if (eintraege[1]) rang2AnzahlProSpieler.set(eintraege[1].login, (rang2AnzahlProSpieler.get(eintraege[1].login) ?? 0) + 1);
    }
    const erreicht = new Set();
    for (const [login, anzahl] of rang2AnzahlProSpieler) {
        if (anzahl >= mindestAnzahlRang2 && !rang1ProSpieler.has(login)) erreicht.add(login);
    }
    return erreicht;
}

/**
 * Fairer Wertrichter: hat ALLE aktuell im Pool befindlichen Strecken per /karma bewertet
 * (Vollstaendigkeits-Eskalation von "Streckenkritiker").
 * @param {Set<string>} bewerteteMapUids Map-UIDs, die dieser Spieler bewertet hat
 * @param {Set<string>} allePoolMapUids alle Map-UIDs aktuell im Pool
 * @returns {boolean}
 */
export function pruefeFairerWertrichter(bewerteteMapUids, allePoolMapUids) {
    if (allePoolMapUids.size === 0) return false;
    for (const uid of allePoolMapUids) {
        if (!bewerteteMapUids.has(uid)) return false;
    }
    return true;
}

/** Rueckkehrer: seit der letzten bekannten Session sind mindestens N Minuten vergangen. */
export function pruefeRueckkehr(letzteSessionBis, jetzt, schwellenWerte) {
    if (!letzteSessionBis) return false;
    const lueckeMinuten = (jetzt.getTime() - letzteSessionBis.getTime()) / 60000;
    return lueckeMinuten >= schwellenWerte.rueckkehrerMinuten;
}

/** Erstbesuch-Erkennung: true, wenn firstSeen (fast) exakt jetzt liegt -- Toleranz gegen Zeitversatz zwischen Schreiben/Lesen des Connect-Events. */
export function istErstbesuch(firstSeen, jetzt, toleranzMs = 5000) {
    if (!firstSeen) return false;
    return Math.abs(jetzt.getTime() - firstSeen.getTime()) <= toleranzMs;
}

/** Willkommenskomitee: Schwelle fuer die Anzahl persoenlich begruesster Neulinge erreicht. */
export function pruefeWillkommenskomitee(anzahlBegruesst, schwellenWerte) {
    return (anzahlBegruesst ?? 0) >= schwellenWerte.willkommenMindestanzahl;
}
