// errungenschaftenKatalog.js -- Reine Daten, KEINE Imports (siehe CLAUDE.md-Testbarkeitsregel:
// controller/plugins/*.js und nextcontrol.js duerfen von Testskripten niemals importiert werden;
// dieses Modul ist bewusst frei von jeglichen Abhaengigkeiten, damit sowohl die Logik-Tests als
// auch website/api.php (per Mongo-Spiegelung, siehe errungenschaften.js) es gefahrlos nutzen koennen).
//
// geheim:true bedeutet: Name + Beschreibung werden dem Client NIE ausgeliefert, solange das
// Abzeichen nicht erreicht ist (siehe website/api.php, Aktion "spieler").

/**
 * @typedef {Object} ErrungenschaftDef
 * @property {string} id
 * @property {string} name
 * @property {string} beschreibung
 * @property {string} icon
 * @property {boolean} geheim
 * @property {number} reihenfolge
 */

/** @type {ErrungenschaftDef[]} */
export const ERRUNGENSCHAFTEN_KATALOG = [
    { id: 'monatsmeister', icon: '🏆', name: 'Monatsmeister', beschreibung: 'Eine Monatswertung gewinnen.', geheim: false, reihenfolge: 1 },
    { id: 'hattrick', icon: '🎩', name: 'Hattrick', beschreibung: 'Drei Monatswertungen in Folge gewinnen.', geheim: false, reihenfolge: 2 },
    { id: 'jahresmeister', icon: '👑', name: 'Jahresmeister', beschreibung: 'Eine Jahreswertung gewinnen.', geheim: false, reihenfolge: 3 },
    { id: 'durchmarsch', icon: '💯', name: 'Durchmarsch', beschreibung: 'Am Monatsende auf allen Strecken des Monats die Bestzeit halten.', geheim: false, reihenfolge: 4 },
    { id: 'podestfahrer', icon: '🥉', name: 'Podestfahrer', beschreibung: 'Einen Monat unter den Top 3 der Punktewertung beenden.', geheim: false, reihenfolge: 5 },
    { id: 'platzhirsch', icon: '🥇', name: 'Platzhirsch', beschreibung: 'Die aktuelle Bestzeit auf mindestens einer Strecke halten.', geheim: false, reihenfolge: 6 },
    { id: 'marathonfahrer', icon: '⏱️', name: 'Marathonfahrer', beschreibung: 'Über 3 Stunden am Stück auf dem Server verbringen.', geheim: false, reihenfolge: 7 },
    { id: 'serienfinisher', icon: '🏁', name: 'Serien-Finisher', beschreibung: '100 Zieldurchfahrten erreichen.', geheim: false, reihenfolge: 8 },
    { id: 'ziellinienlegende', icon: '🔥', name: 'Ziellinien-Legende', beschreibung: '1.000 Zieldurchfahrten erreichen.', geheim: false, reihenfolge: 9 },
    { id: 'checkpointsammler', icon: '🚩', name: 'Checkpoint-Sammler', beschreibung: '10.000 Checkpoints durchfahren.', geheim: false, reihenfolge: 10 },
    { id: 'rundumdieuhr', icon: '🕐', name: 'Rund um die Uhr', beschreibung: '24 Stunden Gesamtspielzeit erreichen.', geheim: false, reihenfolge: 11 },
    { id: 'inventar', icon: '⏳', name: 'Gehört zum Inventar', beschreibung: '100 Stunden Gesamtspielzeit erreichen.', geheim: false, reihenfolge: 12 },
    { id: 'stammgast', icon: '🍻', name: 'Stammgast', beschreibung: '100 Server-Verbindungen erreichen.', geheim: false, reihenfolge: 13 },
    { id: 'streckenkritiker', icon: '⭐', name: 'Streckenkritiker', beschreibung: '10 Strecken mit /karma bewerten.', geheim: false, reihenfolge: 14 },
    { id: 'nachtschwaermer', icon: '🌙', name: 'Nachtschwärmer', beschreibung: 'Zwischen 0 und 4 Uhr nachts ins Ziel fahren.', geheim: true, reihenfolge: 15 },
    { id: 'einsamerwolf', icon: '🐺', name: 'Einsamer Wolf', beschreibung: 'Eine Stunde am Stück ganz allein auf dem Server sein.', geheim: true, reihenfolge: 16 },
    { id: 'lastminutehero', icon: '⏰', name: 'Last-Minute-Held', beschreibung: 'Am letzten Tag des Monats eine neue Bestzeit aufstellen.', geheim: true, reihenfolge: 17 },
    { id: 'wimpernschlag', icon: '📸', name: 'Wimpernschlag', beschreibung: 'Eine Bestzeit mit weniger als 5ms Vorsprung auf Platz 2 halten.', geheim: true, reihenfolge: 18 },
    { id: 'kellerkind', icon: '🛋️', name: 'Kellerkind', beschreibung: 'Über 6 Stunden am Stück auf dem Server verbringen.', geheim: true, reihenfolge: 19 },
    { id: 'vierjahreszeiten', icon: '🍂', name: 'Vier Jahreszeiten', beschreibung: 'In jeder Jahreszeit eines Kalenderjahres mindestens einen Monat aktiv gewesen sein.', geheim: false, reihenfolge: 20 },
    { id: 'jahresfahrer', icon: '📅', name: 'Jahresfahrer', beschreibung: 'In allen 12 Monaten eines Kalenderjahres aktiv gewesen sein.', geheim: false, reihenfolge: 21 },
    { id: 'ewigerzweiter', icon: '🥈', name: 'Ewiger Zweiter', beschreibung: 'Dreimal Monats-Zweiter geworden, aber noch nie Monatsmeister.', geheim: true, reihenfolge: 22 },
    { id: 'willkommenskomitee', icon: '👋', name: 'Willkommenskomitee', beschreibung: 'Drei neuen Spielern bei ihrem allerersten Besuch online begegnet.', geheim: false, reihenfolge: 23 },
    { id: 'rueckkehrer', icon: '↩️', name: 'Rückkehrer', beschreibung: 'Nach mindestens 45 Tagen Pause auf den Server zurückgekehrt.', geheim: false, reihenfolge: 24 },
    { id: 'dauerbrenner', icon: '🔥', name: 'Dauerbrenner', beschreibung: '6 Monate in Folge aktiv gewesen.', geheim: false, reihenfolge: 25 },
    { id: 'fairerwertrichter', icon: '⚖️', name: 'Fairer Wertrichter', beschreibung: 'Alle Strecken im aktuellen Pool mit /karma bewertet.', geheim: false, reihenfolge: 26 },
    { id: 'sofortigerevanche', icon: '💥', name: 'Sofortige Revanche', beschreibung: 'Sich die Führung auf einer Strecke innerhalb von 15 Minuten von einem anderen Spieler zurückgeholt.', geheim: true, reihenfolge: 27 },
];
