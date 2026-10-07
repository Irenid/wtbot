import type { GuideText } from './types'

// German guide text: terms of i18n/de.ts (PSW, Schwadron, Schwadronswertung); "du", as in gaming communities.
export const de: GuideText = {
  term: 'PSW',
  ui: {
    title: 'Ratgeber',
    lead: ({ battles }) =>
      `Wie Schwadronsgefechte und ihre Wertungen funktionieren: wie viel PSW ein Gefecht bringt, wie hoch sie steigen kann, wie die Schwadronswertung berechnet wird, wann die Punkte aktualisiert werden und was ein Gefecht entscheidet. Die Regeln wurden aus öffentlichen Daten von warthunder.com rekonstruiert; die Statistik umfasst alle Schwadronsgefechte in der Datenbank des Bots (${battles}).`,
    quickTitle: 'Kurze Antworten',
    articlesTitle: 'Alle Ratgeber',
    audience: { everyone: 'Alle Spieler', commanders: 'Kommandeure', details: 'Im Detail' },
    prev: 'Zurück',
    next: 'Weiter',
    notFound: 'Diesen Ratgeber gibt es nicht',
    upTo: (n) => `bis ${n}`,
    over: (n) => `über ${n}`,
    andMore: (n) => `ab ${n}`,
    minSec: ({ min, sec }) => `${min} min ${sec} s`,
  },
  quick: {
    points: {
      q: 'Wie viel PSW bringt ein Gefecht?',
      a: () => 'Das hängt von deiner PSW ab — und vom gegnerischen Team, wenn dessen durchschnittliche PSW über 1500 liegt. Gegen ein Team mit durchschnittlich höchstens 1500: Bis 780 bringt ein Sieg +32 und eine Niederlage −1, bei 1500 sind es +16 und −16, bei 2000 +2 und −30.',
    },
    grow: {
      q: 'Wie oft muss ich gewinnen, damit meine PSW steigt?',
      a: () => 'Bei PSW 1300 in mehr als 24 von 100 Gefechten, bei 1500 in mehr als der Hälfte und bei 1800 in mehr als 85 von 100, wenn die Gegner im Schnitt höchstens 1500 haben. Gegen stärkere Teams reichen weniger Siege.',
    },
    ceiling: {
      q: 'Wie hoch steigt meine PSW?',
      a: () => 'Das entscheidet deine Winrate: Bei 50% pendelt sich die PSW um 1500 ein, bei 70% um 1650, bei 90% um 1880. Häufige Gefechte gegen Teams mit durchschnittlich über 1500 heben dieses Niveau an.',
    },
    factors: {
      q: 'Zählen der Gegner und meine Leistung im Gefecht?',
      a: () => 'Deine Leistung nicht: Punkte, Kills, Tode und die Dauer des Gefechts zählen nicht. Der Gegner zählt nur, wenn sein Team im Schnitt über 1500 PSW hat: Dann bringt ein Sieg mehr und eine Niederlage kostet weniger.',
    },
    leave: {
      q: 'Kann ich ein verlorenes Gefecht verlassen, ohne PSW zu verlieren?',
      a: () => 'Nein. Wer das Gefecht verlässt, verliert genauso viel PSW wie bei einer normalen Niederlage.',
    },
    squadron: {
      q: 'Wessen Gefechte erhöhen die Schwadronswertung?',
      a: () => 'Die Gefechte der 20 besten Spieler der Schwadron, solange ihre PSW unter dem Niveau liegt, auf dem sie sich einpendelt. Ein Punkt jedes anderen Spielers ist für die Schwadron 20-mal weniger wert.',
    },
    delay: {
      q: 'Wann wird die PSW nach einem Gefecht aktualisiert?',
      a: ({ delayMin, delayMax, delayMedian }) =>
        `Nach ${delayMin}–${delayMax} Minuten, im Mittel nach ${delayMedian}: Die Seiten von warthunder.com werden höchstens alle 15 Minuten neu erstellt.`,
    },
    battle: {
      q: 'Wie lange dauert ein Schwadronsgefecht?',
      a: ({ battleMedian, wiped }) =>
        `Die Hälfte der Gefechte ist in weniger als ${battleMedian} vorbei. Jeder Spieler hat ein Fahrzeug, und in ${wiped} der Gefechte wird das unterlegene Team bis zum letzten Fahrzeug vernichtet.`,
    },
    favorite: {
      q: 'Gewinnt das Team mit der höheren PSW?',
      a: ({ favoriteWins, favoriteElo }) =>
        `Öfter, aber nicht viel: Mit über 400 Vorsprung gewinnt es ${favoriteWins} der Gefechte, die Formel verspricht ${favoriteElo}.`,
    },
    accuracy: {
      q: 'Woher stammen diese Regeln und wie genau sind sie?',
      a: ({ changes, withinOne }) =>
        `Gaijin veröffentlicht die Formel nicht. Sie wurde rekonstruiert, indem etwa ${changes} PSW-Änderungen mit Gefechtsergebnissen abgeglichen wurden: Für ein einzelnes Gefecht stimmt sie in ${withinOne} der Fälle auf 1 Punkt genau mit der Seite des Spiels überein.`,
    },
  },
  articles: {
    psr: {
      title: 'So funktioniert die PSW',
      summary: 'Punkte für Sieg und Niederlage, ein Rechner, wie hoch die PSW steigen kann, und die Formel.',
    },
    squadron: {
      title: 'Schwadronswertung',
      summary: 'Wie sie sich aus der PSW der Spieler zusammensetzt, wessen Gefechte sie erhöhen, was das Entfernen eines Mitglieds kostet und was für die Top 10 nötig ist.',
    },
    updates: {
      title: 'Aktualisierung und Saison',
      summary: 'Wann die Punkte nach einem Gefecht erscheinen, wie oft diese Website aktualisiert wird, die Saisondaten und die Zeiten der Schwadronsgefechte.',
    },
    battle: {
      title: 'So läuft ein Schwadronsgefecht',
      summary: 'Ein Fahrzeug pro Spieler, wie lange ein Gefecht dauert, wie es endet und was es entscheidet.',
    },
    stats: {
      title: 'Statistik der Schwadronsgefechte',
      summary: 'Wie gut Wertungen den Sieger vorhersagen, wie Gegner zugeteilt werden, wie viel Schwadronen spielen und wie viele Spieler eine hohe PSW erreichen.',
    },
    method: {
      title: 'Wie das gemessen wurde',
      summary: 'Woher die Daten stammen, wie die Formel ermittelt wurde und wie genau sie ist.',
    },
  },
  psr: {
    lead: 'Die PSW ist die persönliche Schwadronswertung. Nach jedem Schwadronsgefecht steigt sie bei einem Sieg und sinkt bei einer Niederlage. Um wie viel, hängt von deiner PSW ab — je höher sie ist, desto weniger bringt ein Sieg und desto mehr kostet eine Niederlage — und vom gegnerischen Team, wenn dessen durchschnittliche PSW über 1500 liegt.',
    points: {
      title: 'Punkte pro Gefecht',
      head: ['PSW', 'Sieg', 'Niederlage', 'Winrate'],
      notes: [
        'Die Tabelle gilt für ein gegnerisches Team mit durchschnittlich höchstens 1500 PSW. Ein stärkeres Team zählt mit seinem Durchschnitt statt 1500: Ein Sieg bringt mehr, eine Niederlage kostet weniger. Bei PSW 1800 gegen ein Team mit durchschnittlich 1800 bringt ein Sieg +16 statt +5 und eine Niederlage −16 statt −27.',
        '**Winrate** — wie viele von 100 Gefechten du gewinnen musst, damit die PSW steigt. Gewinnst du seltener, sinkt sie.',
        'Über 903 sind Sieg und Niederlage zusammen immer 32 Punkte wert: Je weniger ein Sieg bringt, desto mehr kostet eine Niederlage.',
        'Über 1500 kostet eine Niederlage mehr, als ein Sieg bringt: Bei 1800 macht eine Niederlage 5–6 Siege zunichte, bei 2000 etwa 18. Dieselbe Bilanz — 5 Siege und 5 Niederlagen — ergibt deshalb bei PSW 0 ein Plus von 155, bei 1500 genau 0 und bei 2000 ein Minus von 143.',
        'Die PSW fällt nie unter 0. Das Spiel speichert die Nachkommastellen der PSW und zeigt eine ganze Zahl an, daher kann derselbe Sieg wie +16 oder +17 aussehen.',
      ],
    },
    calc: {
      title: 'Rechner',
      intro: 'Gib deine PSW und deine Winrate ein: Der Rechner wendet die Formel für ein gegnerisches Team mit durchschnittlich höchstens 1500 an und zeigt, was du bekommst und wie hoch du steigst.',
      psr: 'Deine PSW',
      winRate: 'Winrate',
      win: 'Für einen Sieg',
      loss: 'Für eine Niederlage',
      hold: 'PSW steigt bei einer Winrate über',
      per10: 'Pro 10 Gefechte im Schnitt',
      ceiling: 'PSW pendelt sich ein bei etwa',
      battles: 'Gefechte bis dahin',
      fromNow: 'ab deiner PSW, im Schnitt',
      reached: 'du bist schon dort',
      above: 'du liegst darüber: Die PSW sinkt im Schnitt',
      endless: 'ohne Niederlagen steigt die PSW unbegrenzt, aber immer langsamer',
      stuck: 'bei dieser Winrate steigt die PSW nicht',
      note: 'Das sind Durchschnittswerte: Echte Sieges- und Niederlagenserien streuen darum.',
    },
    factors: {
      title: 'Was die PSW beeinflusst',
      items: [
        '**Stärke des Gegners — nur über 1500.** Die Formel vergleicht dich mit der durchschnittlichen PSW des gegnerischen Teams, aber nie mit weniger als 1500. Ein Sieg gegen jedes Team mit durchschnittlich höchstens 1500 ist gleich viel wert; gegen ein stärkeres bringt ein Sieg mehr und eine Niederlage kostet weniger.',
        '**Leistung im Gefecht — kein Einfluss.** Punkte, Kills, Tode und die Dauer des Gefechts zählen nicht. Die PSW ändert sich für das ganze Team: für den besten Spieler, für die, die die Verbindung verloren haben, und für die, die nicht geladen haben.',
        '**Verlassen hilft nicht.** Wer ein verlorenes Gefecht verlässt, verliert genauso viel PSW wie bei einer normalen Niederlage.',
        '**Rang in der Schwadron — kein Einfluss.** Kommandeur, Offizier und Gefreiter bekommen dasselbe.',
        '**Am meisten zählt deine eigene PSW.** Für einen Sieg gegen ein Team mit durchschnittlich höchstens 1500 bekommt ein Spieler mit PSW 0 +32 und einer mit 1800 +5.',
      ],
    },
    ceiling: {
      title: 'Wie hoch die PSW steigen kann',
      intro: 'Je höher die PSW, desto weniger bringt ein Sieg. Deshalb pendelt sich die PSW auf einem Niveau ein, das von deiner Winrate abhängt. Bei 50% Siegen erreicht sie 1500 und schwankt dann um diesen Wert. Mehr Gefechte heben dieses Niveau nicht an — du erreichst es nur schneller. Die Tabelle gilt für gegnerische Teams mit durchschnittlich höchstens 1500; stärkere Gegner heben das Niveau: Bei 50% Siegen ist es ihre durchschnittliche PSW.',
      head: ['Winrate', 'PSW pendelt sich ein bei', 'Gefechte ab null'],
      notes: [
        '**Gefechte ab null** — wie viele Gefechte ab Saisonbeginn nötig sind, um bis auf 50 Punkte an dieses Niveau heranzukommen. Eine Glückssträhne kann dich höher bringen, aber die PSW kehrt danach zurück.',
        'Deshalb zeigt die PSW eher die Zahl der Gefechte als das Können: 100 Gefechte mit 40% Siegen ergeben etwa 1170, 20 Gefechte mit 80% etwa 510.',
      ],
      streaks: 'Selbst ohne Niederlagen wird der Anstieg langsamer:',
      streakHead: ['Von PSW', 'Bis PSW', 'Siege in Folge'],
    },
    season: {
      title: 'Saisonbeginn und Pausen',
      body: [
        'Zu Saisonbeginn haben alle PSW 0. Unter 903 kostet eine Niederlage nur 1 Punkt, ein Sieg bringt 31–32, daher wächst die PSW anfangs fast nur mit der Zahl der Siege. Bis 903 braucht es etwa 42 Gefechte bei 70% Siegen, 59 bei 50% und 103 bei 30%. **Am Saisonanfang ist viel spielen also wichtiger** als oft gewinnen.',
        'Ohne Gefechte ändert sich die PSW nicht und bleibt bis Saisonende erhalten. Hat dich eine Glückssträhne über dein Niveau gebracht, kostet jedes weitere Gefecht im Schnitt Punkte, eine Pause dagegen nicht.',
      ],
    },
    formula: {
      title: 'Formel',
      win: 'Sieg',
      loss: 'Niederlage',
      atLeast: (n) => `mindestens ${n}`,
      floor: 'Die PSW fällt nie unter 0',
      opponent: (n) => ['durchschnittliche PSW', 'des gegnerischen Teams,', `mindestens ${n}`],
      body: [
        '**E** ist der Anteil an Siegen, bei dem die PSW gleich bleibt: die Spalte „Winrate“ der [Tabelle](/guides/psr#points), die mit R = 1500 rechnet. Unter 903 würde die Formel für eine Niederlage weniger als 1 Punkt abziehen, deshalb sind es dort immer −1, und 3% Siege genügen zum Steigen.',
        'Beispiel für PSW 1300 gegen ein Team mit durchschnittlich höchstens 1500: x = (1500 − 1300) / 400 = 0,5; 10^0,5 ≈ 3,16; E = 1 / 4,16 ≈ 0,24. Sieg: 32 × 0,76 ≈ +24. Niederlage: 32 × 0,24 ≈ −8.',
        'Über 903 lässt sich das mittlere Ergebnis eines Gefechts einfacher berechnen: 32 × (Anteil der Siege − E). Bei PSW 1300 und 60% Siegen sind das 32 × (0,60 − 0,24) ≈ +11,5 pro Gefecht.',
        'Das ist das Elo-System wie im Schach, mit der durchschnittlichen PSW des gegnerischen Teams als Gegner. Ein schwächeres Team zählt als 1500: Ein Sieg gegen dieses Team bringt so viel wie gegen ein Team mit durchschnittlich 1500.',
      ],
    },
  },
  squadron: {
    lead: 'Die Schwadronswertung addiert die PSW ihrer Spieler, aber nicht gleichmäßig: Die 20 besten zählen voll, die übrigen zu 5%. Das erklärt, wessen Gefechte der Schwadron helfen und warum der Platz in der Tabelle von der Zahl der Gefechte abhängt. Auf dieser Website stehen die Schwadronswertungen unter [Schwadronen](/clans).',
    formula: {
      title: 'Wie sie berechnet wird',
      line: ({ top, share }) => `Schwadronswertung = PSW der ${top} besten + ${share} der PSW der übrigen`,
      body: ['Eine Schwadron hat bis zu 128 Spieler. Es zählt der aktuelle Kader: Inaktive Mitglieder bleiben in der Wertung, und die PSW derer, die gehen, geht mit ihnen.'],
    },
    top20: {
      title: 'Die 20 besten entscheiden',
      body: [
        'Ein Punkt eines Top-20-Spielers ist für die Schwadron 20-mal mehr wert. Ein Sieg eines Top-20-Spielers mit PSW 1500 bringt der Schwadron +16, derselbe Spieler außerhalb der Top 20 bringt +0,8.',
        'Ein Team aus 8 Top-20-Spielern mit etwa 1500 bringt der Schwadron +128 für einen Sieg und −128 für eine Niederlage.',
        'Überholt ein Spieler den 20., zählt er ab dann voll, und der Verdrängte zählt zu 5%. Von da an geht jeder Punkt des neuen Spielers voll an die Schwadron.',
      ],
    },
    who: {
      title: 'Wessen Gefechte Punkte bringen',
      intro: 'Solange die PSW eines Spielers unter dem Niveau liegt, auf dem sie sich bei seiner Winrate einpendelt (Tabelle „[Wie hoch die PSW steigen kann](/guides/psr#ceiling)“), bringen seine Gefechte der Schwadron im Schnitt Punkte. Darüber kosten sie Punkte, selbst wenn er gut spielt:',
      head: ['PSW des Spielers', 'Winrate', 'Im Schnitt pro 10 Gefechte'],
      notes: [
        'Spieler mit 1300 und 1600 gewinnen gleich oft, aber der erste bringt der Schwadron Punkte und der zweite kostet sie: Bei 60% Siegen pendelt sich die PSW bei 1570 ein. Sind zwei Spieler gleich stark, gewinnt die Schwadron mehr, wenn sie den mit der niedrigeren PSW aufstellt — solange der Tausch die Siegchance des Teams nicht senkt.',
        'Ohne Gefechte sinkt die PSW nicht, also behält ein Spieler über seinem Niveau die Punkte der Schwadron, solange er nicht spielt.',
      ],
    },
    roster: {
      title: 'Übrige Mitglieder und Aufräumen des Kaders',
      body: [
        'Auch Mitglieder außerhalb der 20 besten bringen Punkte, jeweils 5% ihrer PSW: 100 Spieler mit PSW 1000 bringen 5.000 — etwa so viel wie drei Top-20-Spieler.',
        'Deshalb kostet das Entfernen eines Mitglieds Punkte. Ein Mitglied außerhalb der Top 20 mit PSW 1000 nimmt 50 mit. Ein Top-20-Mitglied nimmt seine PSW mit, aber der 21. rückt nach und zählt dann voll: Die Schwadron verliert die PSW des Gehenden minus 95% der PSW des 21. Beispiel: Ein Spieler mit 1800 geht, der 21. hat 1500 — die Schwadron verliert 1800 − 1425 = 375.',
      ],
    },
    ceiling: {
      title: 'Obergrenze der Schwadron',
      intro: 'Haben die 20 besten ihr Niveau erreicht, wächst die Schwadronswertung nicht mehr mit der Zahl der Gefechte, sondern nur mit der Winrate:',
      head: ['Winrate der 20 besten', 'PSW jedes Einzelnen', 'Summe der 20 besten'],
      notes: ({ battlesLow, battlesHigh, hoursLow, hoursHigh }) => [
        `Dazu kommen 5% der PSW der übrigen. Jeder der 20 besten braucht ${battlesLow}–${battlesHigh} Gefechte bis zu seinem Niveau, beim üblichen [Spieltempo](/guides/battle#length) sind das ${hoursLow}–${hoursHigh} Stunden Schwadronsgefechte. Bis dahin wächst die Schwadronswertung auch mit der Zahl der Gefechte.`,
        'Glückssträhnen und Spieler mit hoher PSW, die nicht mehr spielen, können eine Schwadron über diesem Niveau halten: Ohne Gefechte sinkt die PSW nicht.',
      ],
    },
    live: {
      title: 'Die Tabelle gerade jetzt',
      updated: (when) => `Stand: ${when}`,
      places: 'Was ein Platz in der Wertungstabelle erfordert:',
      placesHead: ['Platz', 'Schwadronswertung'],
      groups: 'Durchschnitt der Schwadronen auf diesen Plätzen:',
      groupsHead: ['Plätze', 'Winrate', 'Gefechte der Saison', 'Spieler'],
      conclusion: ({ times }) => `Schwadronen auf den Plätzen 1–10 haben ${times}-mal so viele Gefechte gespielt wie die auf den Plätzen 51–100.`,
      note: 'Daten aus der offiziellen Wertungstabelle von warthunder.com.',
      empty: 'Die Wertungstabelle ist gerade nicht verfügbar.',
    },
  },
  updates: {
    lead: 'Die PSW ändert sich direkt nach dem Gefecht, doch die Seiten von warthunder.com zeigen sie bis zu 15 Minuten später. Hier: woher die Verzögerung kommt, wie oft diese Website aktualisiert wird, die Saisondaten und die Zeiten der Schwadronsgefechte.',
    delay: {
      title: 'Wann die Punkte erscheinen',
      body: ({ min, max, median }) => [
        'Das Spiel erfasst das Ergebnis eines Gefechts etwa 30 Sekunden nach dessen Ende. Die Schwadronsseiten und die Wertungstabelle auf warthunder.com zeigen es aber nicht sofort: Die Seite des Spiels hält eine Kopie davon 15 Minuten lang vor und erstellt beim ersten Aufruf danach eine neue.',
        `Deshalb erscheint die neue PSW ${min}–${max} Minuten nach dem Gefecht, im Mittel nach ${median}. Öfter neu zu laden bringt nichts: Solange die Kopie nicht älter als 15 Minuten ist, zeigt die Seite des Spiels sie an. Sind seit dem Ende des Gefechts mehr als 15 Minuten vergangen, lade die Schwadronsseite neu: Sie zeigt dann das Ergebnis.`,
        'Gefechte innerhalb dieser 15 Minuten erscheinen gemeinsam. Sie werden nacheinander in der Reihenfolge ihres Endes verrechnet, jedes ausgehend von der PSW nach dem vorherigen.',
        'Die Wertungstabelle funktioniert genauso, aber jede ihrer Seiten (20 Schwadronen) wird für sich aktualisiert, getrennt von den Schwadronsseiten. Deshalb können Tabelle und Schwadronsseite eine Zeit lang verschiedene Wertungen zeigen.',
      ],
    },
    site: {
      title: 'Wie diese Website aktualisiert wird',
      body: [
        'Diese Website übernimmt Schwadronswertungen und Plätze aus der Wertungstabelle von warthunder.com: die Top 100 alle 20 Minuten, die übrigen alle 12 Stunden. Zusammen mit der 15-Minuten-Kopie auf warthunder.com liegen die Wertungen der Spitzenreiter hier meist höchstens 35 Minuten hinter dem Spiel.',
        'Die PSW der Spieler stammt von den Schwadronsseiten: Der Bot liest die Seite einer Schwadron, wenn er ein Gefecht mit ihr veröffentlicht, und geht einmal täglich die Kader der Top-100-Schwadronen durch. Die PSW eines Spielers kann hier daher hinter dem Spiel liegen.',
      ],
    },
    season: {
      title: 'Saison',
      body: ['Zu Beginn einer Saison werden die PSW aller Spieler und die Wertung aller Schwadronen auf null gesetzt. Die Saison ist in Etappen unterteilt, jede mit eigenem Höchst-BR der Fahrzeuge:'],
    },
    hours: {
      title: 'Zeiten der Schwadronsgefechte',
      body: ({ first, second, peak, firstShare, firstPsr, secondPsr }) => [
        `Schwadronsgefechte laufen täglich in zwei Zeitfenstern (in deiner Ortszeit): ${first} und ${second}. Im ersten Fenster finden ${firstShare} aller Gefechte statt, die Hauptzeit ist ${peak}.`,
        `Im zweiten Fenster sind die Gegner etwas stärker: Die durchschnittliche PSW eines Teams liegt dort typischerweise bei ${secondPsr}, im ersten bei ${firstPsr}.`,
      ],
    },
  },
  battle: {
    lead: ({ battles }) =>
      `Alle Schwadronsgefechte sind 8 gegen 8, Realistisch, Vorherrschaft. Hier: wie sie ablaufen und was sie entscheidet, über alle Schwadronsgefechte in der Datenbank des Bots (${battles}).`,
    vehicles: {
      title: 'Ein Fahrzeug pro Gefecht',
      body: ({ aircraft, none, four }) => [
        'Im Schwadronsgefecht hat jeder Spieler ein Fahrzeug. Wird es zerstört, ist der Spieler bis zum Ende des Gefechts raus, und das Team spielt ohne ihn weiter.',
        `${aircraft} der Fahrzeuge in Gefechten sind Flugzeuge und Hubschrauber, der Rest sind Bodenfahrzeuge. Am häufigsten nimmt ein Team entweder kein Flugzeug mit (so spielen ${none} der Teams) oder vier (${four}). Mehr als vier gibt es fast nie.`,
      ],
    },
    length: {
      title: 'Wie lange ein Gefecht dauert',
      body: ({ median, p90, over10, firstKill, gap, series, perHour }) => [
        `Die Hälfte der Gefechte ist in weniger als ${median} vorbei, neun von zehn in weniger als ${p90}. Länger als 10 Minuten dauern nur ${over10} der Gefechte. Das erste Fahrzeug wird meist ${firstKill} nach dem Start zerstört.`,
        `Das nächste Gefecht beginnt meist ${gap} nach dem Ende des vorherigen. Eine typische Serie sind ${series} Gefechte am Stück, und in einer Stunde spielt ein Trupp im Schnitt ${perHour} Gefechte, Pausen eingerechnet.`,
      ],
    },
    ending: {
      title: 'Wie ein Gefecht endet',
      body: ({ wiped, captured, onlyAircraft, survivors }) => [
        `In ${wiped} der Gefechte wird das unterlegene Team bis zum letzten Fahrzeug vernichtet.`,
        `In den übrigen hatten die Verlierer noch Fahrzeuge, verloren aber über die Zonen: In ${captured} dieser Gefechte eroberten die Sieger mehr Zonen. Meist waren den Verlierern nur noch Flugzeuge geblieben (${onlyAircraft} dieser Gefechte), und Flugzeuge können keine Zonen erobern.`,
        `Auch ein Sieg kostet viel: Bei den Siegern überleben bis zum Ende meist ${survivors} von 8 Spielern.`,
      ],
    },
    decides: {
      title: 'Was ein Gefecht entscheidet',
      intro: 'Wie oft ein Team gewinnt, das Folgendes hat:',
      head: ['Das Team hat', 'Siege'],
      rows: {
        moreKills: 'Mehr Kills als der Gegner',
        firstKill: 'Den ersten Kill des Gefechts',
        fewerKills: 'Weniger Kills als der Gegner',
        notLoaded: 'Einen nicht geladenen Spieler mehr',
        bot: 'Einen Bot statt eines nicht geladenen Spielers',
        psr: ({ gap }) => `Mittlere PSW um ${gap} oder mehr höher`,
        squadron: ({ gap }) => `Schwadronswertung um ${gap} oder mehr höher`,
      },
      notes: ({ withFirst, withoutFirst, notLoadedBattles, botWins, botBattles, aircraft, aircraftKills, spread }) => [
        `**Der erste Kill** zählt nicht nur, weil ihn meist die Stärkeren holen. Selbst eine Schwadron, die die Hälfte ihrer Gefechte gewinnt, gewinnt mit dem ersten Kill ${withFirst} der Gefechte und ohne ihn ${withoutFirst}.`,
        '**Mit weniger Kills** verliert ein Team fast immer, und seine seltenen Siege kommen meist über die Zonen.',
        `**Ein nicht geladener Spieler** bedeutet fast eine Niederlage (${notLoadedBattles} solcher Gefechte in den Daten). Meist übernimmt ein Bot seinen Platz, aber selbst dann gewinnt das Team nur ${botWins} von ${botBattles} Gefechten.`,
        `**Luftfahrzeuge.** Flugzeuge und Hubschrauber sind ${aircraft} der Fahrzeuge, erzielen aber ${aircraftKills} der Kills. Trotzdem hängt der Sieg kaum von ihrer Zahl ab: Die Winrate derselben Schwadron weicht bei jeder Zahl an Flugzeugen, von 0 bis 4, um höchstens ${spread} von ihrer üblichen ab.`,
        'Mehr dazu, wie Wertungen den Sieger vorhersagen, in der [Statistik](/guides/stats#psr).',
      ],
    },
    sides: {
      title: 'Kartenseiten',
      body: ({ team1, team2, maps, minBattles, low, high }) => [
        `Die Kartenseite bringt keinen Vorteil: Team 1 und Team 2 haben fast gleich oft gewonnen (${team1} und ${team2}). Auf jeder Karte mit über ${minBattles} Gefechten (${maps} Karten) gewinnt die erste Seite ${low} bis ${high} der Gefechte, im Rahmen des Zufalls.`,
      ],
    },
  },
  stats: {
    lead: ({ battles, date }) =>
      `Schwadronsgefechte in der Datenbank des Bots, Stand ${date}: ${battles}. Alle sind 8 gegen 8, Realistisch, Vorherrschaft.`,
    psr: {
      title: 'Wie gut die PSW den Sieger vorhersagt',
      intro: 'Das Team mit der höheren durchschnittlichen PSW gewinnt öfter, aber viel seltener, als die Formel verspricht:',
      head: ['Differenz der mittleren Team-PSW', 'Team mit höherer PSW gewinnt', 'Laut PSW-Formel', 'Gefechte'],
      notes: [
        '**Laut PSW-Formel** — wie oft das Team gewinnen würde, wenn die PSW die Stärke genau messen würde. Der echte Vorteil ist kleiner: Die PSW wächst mit der Zahl der Gefechte, nicht nur mit dem Können ([warum](/guides/psr#ceiling)). Über die Stärke eines Spielers sagt seine Winrate mehr.',
      ],
    },
    squadron: {
      title: 'Wie gut die Schwadronswertung den Sieger vorhersagt',
      head: ['Differenz der Schwadronswertung', 'Höher bewertete Schwadron gewinnt', 'Gefechte'],
      notes: ({ even, strong, strongWins }) => [
        `Bei einer Differenz bis ${even} gewinnen beide Schwadronen etwa gleich oft. Erst bei einer Differenz über ${strong} gewinnt die höher bewertete Schwadron ${strongWins} der Gefechte: Die Wertung wächst mit der Zahl der Gefechte, und im Gefecht kämpfen nur 8 Spieler, nicht unbedingt die stärksten.`,
      ],
    },
    matchmaking: {
      title: 'Zuteilung der Gegner',
      body: ({ psrReal, psrRandom, squadronReal, squadronRandom, repeat, opponents }) => [
        `Das Matchmaking berücksichtigt Wertungen nur schwach. Die durchschnittliche PSW der Teams eines Gefechts unterscheidet sich typischerweise um ${psrReal}, bei zwei zufälligen Teams, die innerhalb derselben 2 Stunden gespielt haben, um ${psrRandom}. Bei der Schwadronswertung sind es ${squadronReal} gegenüber ${squadronRandom}. Ein Gegner mit 200 PSW mehr oder weniger ist normal.`,
        `Gegner wiederholen sich oft: Innerhalb eines [Zeitfensters der Schwadronsgefechte](/guides/updates#hours) gehen ${repeat} der Gefechte einer Schwadron gegen eine Schwadron, gegen die sie in diesem Fenster schon gespielt hat. In 10 Gefechten in Folge trifft sie im Schnitt auf ${opponents} verschiedene Gegner.`,
      ],
    },
    distribution: {
      title: 'Wie viele Spieler eine hohe PSW erreichen',
      intro: ({ players, zero }) =>
        `Schwadronsspieler, deren PSW der Bot in dieser Saison gesehen hat: ${players}. ${zero} von ihnen haben PSW 0: Sie haben in dieser Saison noch nicht gewonnen. Unter den übrigen:`,
      head: ['PSW', 'Anteil der Spieler'],
      notes: ({ median, top10, top1, max }) => [
        `Die Hälfte von ihnen liegt unter ${median}. Die besten 10% beginnen bei ${top10}, die besten 1% bei ${top1}. Die höchste PSW, die der Bot gesehen hat, ist ${max}.`,
      ],
    },
    activity: {
      title: 'Wie viel gespielt wird',
      intro: ({ from, to }) => `Ein gewöhnlicher Tag dieser Saison — Mittelwerte über die vollen Tage vom ${from} bis ${to}:`,
      head: ['Pro Tag', 'Im Mittel'],
      rows: {
        battles: 'Schwadronsgefechte',
        squadrons: 'Schwadronen in Gefechten',
        players: 'Spieler in Gefechten',
        squadronDay: 'Gefechte einer Schwadron',
        playerDay: 'Gefechte eines Spielers',
      },
      notes: ({ low, high, topLow, topHigh, from, to, playersLow, playersHigh }) => [
        `Gefechte pro Tag: von ${low} bis ${high}. Schwadronen und Spieler zählen nur an den Tagen, an denen sie gespielt haben.`,
        `Die 10 aktivsten Schwadronen spielen ${topLow} bis ${topHigh} Gefechte am Tag und haben vom ${from} bis ${to} jeweils ${playersLow} bis ${playersHigh} verschiedene Spieler eingesetzt. Voll in die Schwadronswertung gehen davon nur die 20 besten ein ([warum](/guides/squadron#top20)).`,
      ],
    },
  },
  method: {
    lead: 'Gaijin veröffentlicht die PSW-Formel nicht. Die Regeln in diesen Ratgebern wurden aus öffentlichen Daten von warthunder.com rekonstruiert und an echten Gefechten geprüft. Das sind keine offiziellen Daten: Gaijin kann die Regeln jederzeit ändern, und dann sind die Zahlen hier veraltet.',
    data: {
      title: 'Daten',
      body: ({ date, battles, changes, psrBattles, squadronBattles, from1, to1, from2, to2 }) => [
        `Der Bot sammelt die PSW der Schwadronsmitglieder und die Wertungstabelle der Schwadronen von den Seiten von warthunder.com, und aus den Gefechtsreplays, wer mit welchem Fahrzeug gespielt hat, wer wen zerstört hat, wer Zonen erobert und wer gewonnen hat. Stand ${date} enthält die Datenbank ${battles} Schwadronsgefechte und ${changes} PSW-Änderungen. Die Gefechte stammen vom ${from1} bis ${to1} und vom ${from2} bis ${to2}: An den übrigen Tagen hat der Bot keine gesammelt.`,
        `Vergleiche der Team-PSW nutzen Gefechte, in denen die PSW von mindestens 6 der 8 Spieler jedes Teams bekannt ist (${psrBattles}); Vergleiche der Schwadronen nutzen Gefechte, in denen die Wertungen beider Schwadronen bekannt sind (${squadronBattles}).`,
      ],
    },
    formula: {
      title: 'PSW-Formel',
      body: ({ single, k, reference, scale, withinOne, chainLow, chainHigh, liveMatched, liveTotal, max, strong, fixed, enemy, weaker }) => [
        `Die Formel wurde an Fällen ermittelt, in denen zwischen zwei Abrufen der PSW eines Spielers genau ein Gefecht lag (${single}). Am besten passte das Elo-System. Die ermittelten Werte (${k}; ${reference}; ${scale}) entsprechen 32, 1500 und 400.`,
        `Für ein einzelnes Gefecht stimmt die Formel in ${withinOne} der Fälle auf 1 Punkt genau mit der Seite des Spiels überein. Änderungen über mehrere Gefechte erklärt sie je nach PSW zu ${chainLow}–${chainHigh}. Bei einer Live-Prüfung stimmten ${liveMatched} von ${liveTotal} Änderungen überein.`,
        `Eine größere Prüfung im Oktober 2026 zeigte, dass ein starker Gegner doch zählt. In ${strong} Änderungen nach einem Gefecht gegen ein Team mit durchschnittlich über 1500 stimmte ein fester Gegner von 1500 nur in ${fixed} der Fälle auf 1 Punkt genau mit der Seite des Spiels überein, die durchschnittliche PSW des gegnerischen Teams in ${enemy}. Gegen schwächere Teams ergeben beide ${weaker}: Der Gegner zählt nie als schwächer als 1500.`,
        `Geprüft an PSW von 0 bis ${max}, der höchsten PSW in den Daten; darüber gibt es nichts, woran sich die Formel prüfen ließe.`,
      ],
    },
    squadron: {
      title: 'Schwadronswertung',
      body: ({ states, errorLow, errorHigh }) => [
        `Die Formel der Schwadronswertung wurde an ${states} Ständen von Schwadronsseiten geprüft: Die Abweichung betrug ${errorLow} bis ${errorHigh} Punkte — die Nachkommastellen der PSW, die die Seite des Spiels nicht zeigt.`,
      ],
    },
    timing: {
      title: 'Zeitpunkt der Aktualisierung',
      body: ({ date, from, to, poll, squadrons, battles, min, max, median, fresh, timer }) => [
        `Am ${date} von ${from} bis ${to} UTC las der Bot während ihrer Gefechte alle ${poll} Sekunden die Seiten von ${squadrons} Schwadronen. Bei ${battles} Gefechten erschien das Ergebnis ${min}–${max} Minuten nach Gefechtsende, im Mittel nach ${median}.`,
        `Die Seiten wurden genau im Abstand von 15 Minuten aktualisiert, und der erste Abruf nach einer Pause bekam in ${fresh} der Fälle frische Daten; eine Seite mit festem Takt ergäbe etwa ${timer}. Die Seite wird also auf Anfrage neu erstellt, sobald ihre Kopie älter als 15 Minuten ist.`,
      ],
    },
    code: {
      title: 'Code',
      body: ({ url }) => [`Die Formel und jede Tabelle dieser Ratgeber werden im offenen Quellcode der Website berechnet: [lib/psr.ts](${url}).`],
    },
  },
}
