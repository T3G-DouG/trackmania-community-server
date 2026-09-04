/**
 * Reine Hilfsfunktionen zur Ermittlung eines "Geschmacksprofils" aus Karma-Bewertungen,
 * zur Bewertung von Map-Kandidaten anhand dieses Profils und zur Erzeugung einer
 * automatischen Kurzbeschreibung je Strecke (fuers Telegram-Voting).
 *
 * Bewusst ohne Abhaengigkeit zu nextcontrol.js/Mongo gehalten (wie lib/mapVoting.js),
 * damit sich die Logik ohne laufenden Server/DB testen laesst.
 */

import { msToString } from '../../controller/lib/utilities.js';

// Gewichte in bewerteKandidat() -- Autor bleibt das staerkste Signal (einziges bereits
// durch echte Gruppen-Karma-Stimmen bestaetigtes Merkmal); die TMX-Signale (Tags/
// Schwierigkeit/Laenge) stehen bewusst auf gleicher Stufe wie Environment, wie vom
// Betreiber gewuenscht ("gleichrangig zu bestehenden Signalen"). Leicht anpassbar.
export const GEWICHT_AUTOR = 2;
export const GEWICHT_ENVIRONMENT = 1;
export const GEWICHT_MOOD = 0.5;
export const GEWICHT_TAGS = 1;
export const GEWICHT_SCHWIERIGKEIT = 1;
export const GEWICHT_LAENGENKATEGORIE = 1;
export const GEWICHT_STYLE = 1;

// Deckelung der Tag-Uebereinstimmung: manche TMX-Maps haben 6-8 Tags -- ohne Deckel
// wuerden tag-reiche Maps strukturell bevorzugt. Nur die N hoechstgewichteten
// uebereinstimmenden Tags zaehlen (additiv wie die anderen Signale, aber begrenzt).
export const TAG_MAX_ANZAHL = 3;

// Laenge wird gebuckett und dann additiv wie Environment/Mood behandelt (kein separates,
// distanzbasiertes Scoring -- bleibt konsistent zum bestehenden exact-match-Muster).
export const LAENGE_KATEGORIEN = [
    { name: 'kurz', maxMs: 30_000 },
    { name: 'mittel', maxMs: 60_000 },
    { name: 'lang', maxMs: 120_000 },
    { name: 'sehrLang', maxMs: Infinity },
];

/** Ordnet eine Laenge (ms) einer LAENGE_KATEGORIEN-Kategorie zu, null bei ungueltigem Wert. */
export function laengenKategorie(laengeMs) {
    if (laengeMs == null || !Number.isFinite(laengeMs) || laengeMs < 0) return null;
    return LAENGE_KATEGORIEN.find((k) => laengeMs <= k.maxMs)?.name ?? null;
}

/**
 * Ermittelt aus einer Karma-Aggregation die UIDs der "beliebten" Maps (Mindeststimmen +
 * Mindestdurchschnitt erreicht, Map-Metadaten vorhanden) -- Single Source of Truth fuer
 * "was ist beliebt", von berechneGeschmacksprofil() intern genutzt und von aussen (z.B.
 * um die passenden TMX-Daten vorab zu laden) wiederverwendbar.
 * @param {Array<{_id: String, schnitt: Number, stimmen: Number}>} karmaAggregation
 * @param {Map<String, Object>} mapMetaByUid
 * @param {Number} minStimmen
 * @param {Number} minSchnitt
 * @returns {String[]}
 */
export function ermittleBeliebteMapUids(karmaAggregation, mapMetaByUid, minStimmen = 2, minSchnitt = 6) {
    return karmaAggregation
        .filter((k) => k.stimmen >= minStimmen && k.schnitt >= minSchnitt && mapMetaByUid.has(k._id))
        .map((k) => k._id);
}

/**
 * Baut ein Geschmacksprofil aus Karma-Durchschnitten + Map-Metadaten (+ optional TMX-Daten).
 * @param {Array<{_id: String, schnitt: Number, stimmen: Number}>} karmaAggregation Ergebnis einer $group-Aggregation ueber die karma-Collection (_id = map-uid)
 * @param {Map<String, {author: String, envi: String, mood: String, style: String}>} mapMetaByUid Map-Metadaten (aus maps ∪ archivMaps), Key = uid
 * @param {Object} [optionen]
 * @param {Number} [optionen.minStimmen] Mindestanzahl Stimmen, damit eine Map in die Wertung eingeht (Rauschen vermeiden)
 * @param {Number} [optionen.minSchnitt] Mindest-Durchschnitt, ab dem eine Map als "beliebt" gilt (Skala 1-10)
 * @param {Map<String, {tags:Array<{name:String}>, schwierigkeit:Number|null, laenge:Number|null}|null>} [optionen.tmxDatenByUid] TMX-Daten je Map-UID (z.B. aus scripts/lib/tmxCache.js), fehlende Eintraege werden uebersprungen
 * @returns {{autoren: Map, umgebungen: Map, stimmungen: Map, stile: Map, tags: Map, schwierigkeiten: Map, laengenKategorien: Map} | null}
 */
export function berechneGeschmacksprofil(karmaAggregation, mapMetaByUid, optionen = {}) {
    const { minStimmen = 2, minSchnitt = 6, tmxDatenByUid = new Map() } = optionen;
    const beliebteUids = new Set(ermittleBeliebteMapUids(karmaAggregation, mapMetaByUid, minStimmen, minSchnitt));
    const beliebt = karmaAggregation.filter((k) => beliebteUids.has(k._id));

    if (beliebt.length === 0) return null;

    const autoren = new Map(), umgebungen = new Map(), stimmungen = new Map(), stile = new Map();
    const tags = new Map(), schwierigkeiten = new Map(), laengenKategorien = new Map();

    const addiere = (map, schluessel, gewicht) => {
        if (schluessel == null) return;
        map.set(schluessel, (map.get(schluessel) ?? 0) + gewicht);
    };

    for (const k of beliebt) {
        const meta = mapMetaByUid.get(k._id);
        const gewicht = k.schnitt - 5; // 1..5, je beliebter desto staerkeres Gewicht
        addiere(autoren, meta.author, gewicht);
        addiere(umgebungen, meta.envi, gewicht);
        addiere(stimmungen, meta.mood, gewicht);
        addiere(stile, meta.style || null, gewicht); // leerer String ("" wenn MapStyle fehlt) zaehlt nicht als Signal

        const tmxDaten = tmxDatenByUid.get(k._id);
        if (!tmxDaten) continue;
        for (const tag of tmxDaten.tags ?? []) addiere(tags, tag.name, gewicht);
        addiere(schwierigkeiten, tmxDaten.schwierigkeit, gewicht);
        addiere(laengenKategorien, laengenKategorie(tmxDaten.laenge), gewicht);
    }

    return { autoren, umgebungen, stimmungen, stile, tags, schwierigkeiten, laengenKategorien };
}

/**
 * Bewertet einen einzelnen Kandidaten anhand des Geschmacksprofils (+ optional TMX-Daten
 * des Kandidaten selbst).
 * @param {{author: String, envi: String, mood: String, style: String}} mapMeta Metadaten des Kandidaten (z.B. aus GetMapInfo)
 * @param {{autoren: Map, umgebungen: Map, stimmungen: Map, stile: Map, tags: Map, schwierigkeiten: Map, laengenKategorien: Map} | null} profil Ergebnis von berechneGeschmacksprofil()
 * @param {{tags:Array<{name:String}>, schwierigkeit:Number|null, laenge:Number|null} | null} [tmxDaten] TMX-Daten des Kandidaten, fehlt bei nie auf TMX gefundenen Maps
 * @returns {Number} Aehnlichkeits-Punktzahl, 0 wenn kein Profil vorhanden oder keine Uebereinstimmung
 */
export function bewerteKandidat(mapMeta, profil, tmxDaten = null) {
    if (!profil) return 0;

    const autorGewicht = profil.autoren.get(mapMeta.author) ?? 0;
    const enviGewicht = profil.umgebungen.get(mapMeta.envi) ?? 0;
    const moodGewicht = profil.stimmungen.get(mapMeta.mood) ?? 0;
    const stilGewicht = profil.stile.get(mapMeta.style || null) ?? 0;

    let tagGewicht = 0, schwierigkeitGewicht = 0, laengeGewicht = 0;
    if (tmxDaten) {
        const tagTreffer = (tmxDaten.tags ?? [])
            .map((tag) => profil.tags.get(tag.name) ?? 0)
            .filter((w) => w > 0)
            .sort((a, b) => b - a)
            .slice(0, TAG_MAX_ANZAHL);
        tagGewicht = tagTreffer.reduce((summe, w) => summe + w, 0);

        schwierigkeitGewicht = profil.schwierigkeiten.get(tmxDaten.schwierigkeit) ?? 0;
        laengeGewicht = profil.laengenKategorien.get(laengenKategorie(tmxDaten.laenge)) ?? 0;
    }

    return Math.max(0, autorGewicht) * GEWICHT_AUTOR
        + Math.max(0, enviGewicht) * GEWICHT_ENVIRONMENT
        + Math.max(0, moodGewicht) * GEWICHT_MOOD
        + Math.max(0, stilGewicht) * GEWICHT_STYLE
        + Math.max(0, tagGewicht) * GEWICHT_TAGS
        + Math.max(0, schwierigkeitGewicht) * GEWICHT_SCHWIERIGKEIT
        + Math.max(0, laengeGewicht) * GEWICHT_LAENGENKATEGORIE;
}

/**
 * Macht aus einem rohen Mood-Wert wie "48x48Sunset" oder "NoStadium48x48Day" den
 * lesbaren Teil ("Sunset"/"Day"). Die Zahlen-Praefixe/-Suffixe sind je nach Environment-
 * Mod unterschiedlich angeordnet, deshalb wird gezielt nach den bekannten Tageszeiten
 * gesucht statt eines festen Prefixes.
 * @param {String|undefined} mood
 * @returns {String|null}
 */
export function lesbareStimmung(mood) {
    if (!mood) return null;
    const bekannt = ['Sunrise', 'Sunset', 'Night', 'Day'];
    return bekannt.find((w) => mood.includes(w)) || mood;
}

/**
 * Erzeugt eine kompakte, automatische Kurzbeschreibung einer Strecke aus den
 * per GetMapInfo verfuegbaren Metadaten -- ohne GBX-Parser oder externe Quelle,
 * rein aus Environment/Mood/Style/Rundenmodus/Autorzeit/Autor.
 * @param {{envi: String, mood: String, style: String, isMultilap: Boolean, author: String, authorNickname: String, medals: {author: Number}}} meta
 * @returns {String}
 */
export function erzeugeKurzbeschreibung(meta) {
    const teile = [];

    if (meta.style) teile.push(`${meta.style}-Style`);

    const stimmung = lesbareStimmung(meta.mood);
    teile.push(stimmung ? `${meta.envi ?? '?'} (${stimmung})` : (meta.envi ?? '?'));

    if (meta.isMultilap) teile.push('Rundstrecke');

    if (meta.medals?.author) teile.push(`Autorzeit ${msToString(meta.medals.author)}`);

    const autor = meta.authorNickname || meta.author;
    if (autor) teile.push(`von ${autor}`);

    return teile.join(' · ');
}

// Gleiche Zuordnung wie website/index.html (TMX_SCHWIERIGKEIT) -- bewusst dupliziert wie
// die anderen TMX-Feldsaetze zwischen PHP/JS/Node (kein gemeinsames Modul zwischen
// Website und Controller/Scripts).
export const TMX_SCHWIERIGKEIT_NAMEN = ['Anfänger', 'Fortgeschritten', 'Schwer', 'Experte'];

/**
 * Erzeugt eine ausfuehrliche Kandidaten-Beschreibung fuer die persistierte Abstimmungs-
 * Collection (abstimmungStatus), die ausschliesslich voting.html anzeigt -- kein
 * Zeichenlimit wie bei den Telegram-Poll-Optionen. Baut auf erzeugeKurzbeschreibung() auf
 * und haengt bei vorhandenen TMX-Daten (meta.tmxDaten, siehe waehleKandidatenNachAehnlichkeit())
 * zusaetzlich Tags/Schwierigkeit/Laenge/Awards/Upload-Datum an. Ohne TMX-Daten identisch zur Kurzform.
 * @param {{envi: String, mood: String, style: String, isMultilap: Boolean, author: String, authorNickname: String, medals: {author: Number}, tmxDaten?: {tags:Array<{name:String}>, schwierigkeit:Number|null, laenge:Number|null, awards:Number|null, hochgeladenAm:String|null}|null}} meta
 * @returns {String}
 */
export function erzeugeAusfuehrlicheBeschreibung(meta) {
    const teile = [erzeugeKurzbeschreibung(meta)];

    const tmxDaten = meta.tmxDaten;
    if (tmxDaten) {
        const tagNamen = (tmxDaten.tags ?? []).map((t) => t.name).filter(Boolean);
        if (tagNamen.length) teile.push(`Tags: ${tagNamen.join(', ')}`);

        const schwierigkeit = (tmxDaten.schwierigkeit != null && TMX_SCHWIERIGKEIT_NAMEN[tmxDaten.schwierigkeit])
            ? TMX_SCHWIERIGKEIT_NAMEN[tmxDaten.schwierigkeit] : null;
        if (schwierigkeit) teile.push(`Schwierigkeit ${schwierigkeit}`);

        if (tmxDaten.laenge != null) teile.push(`Länge ${tmxDaten.laenge}`);

        if (tmxDaten.awards != null) teile.push(`${tmxDaten.awards} 🏆`);

        if (tmxDaten.hochgeladenAm) {
            const datum = new Date(tmxDaten.hochgeladenAm);
            if (!isNaN(datum)) teile.push(`hochgeladen am ${datum.toLocaleDateString('de-DE')}`);
        }
    }

    return teile.join(' · ');
}

/**
 * Erzeugt die kompakte Beschreibung fuer den Telegram-Poll-Options-Text (nach dem
 * Kartennamen, "Name — <beschreibung>", Telegram-Hartlimit 100 Zeichen je Option --
 * das Kuerzen selbst passiert im Aufrufer). Betreiber-Wunsch: das Voting ist NUR NOCH
 * der Poll selbst (keine separate Vorschau-Nachricht mehr), daher hier bewusst knapper
 * als erzeugeAusfuehrlicheBeschreibung() -- ohne Ersteller/Awards/Upload-Datum (entfallen
 * hier ausdruecklich), Tags auf die 2 wichtigsten gekuerzt, "Autorzeit" zu "AT" verkuerzt.
 * @param {{envi: String, mood: String, style: String, isMultilap: Boolean, medals: {author: Number}, tmxDaten?: {tags:Array<{name:String}>, schwierigkeit:Number|null}|null}} meta
 * @returns {String}
 */
export function erzeugeKompakteBeschreibung(meta) {
    const teile = [];

    if (meta.style) teile.push(`${meta.style}-Style`);

    const stimmung = lesbareStimmung(meta.mood);
    teile.push(stimmung ? `${meta.envi ?? '?'} (${stimmung})` : (meta.envi ?? '?'));

    if (meta.isMultilap) teile.push('Rundstrecke');

    if (meta.medals?.author) teile.push(`AT ${msToString(meta.medals.author)}`);

    const tmxDaten = meta.tmxDaten;
    if (tmxDaten) {
        const tagNamen = (tmxDaten.tags ?? []).map((t) => t.name).filter(Boolean).slice(0, 2);
        if (tagNamen.length) teile.push(tagNamen.join(', '));

        const schwierigkeit = (tmxDaten.schwierigkeit != null && TMX_SCHWIERIGKEIT_NAMEN[tmxDaten.schwierigkeit])
            ? TMX_SCHWIERIGKEIT_NAMEN[tmxDaten.schwierigkeit] : null;
        if (schwierigkeit) teile.push(schwierigkeit);
    }

    return teile.join(' · ');
}
