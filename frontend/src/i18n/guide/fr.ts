import type { GuideText } from './types'

// French guide text: terms of i18n/fr.ts (NPE, escadron, note de l'escadron); a no-break space before : ; ? and inside « ».
export const fr: GuideText = {
  term: "NPE",
  ui: {
    title: "Guides",
    lead: ({ battles }) =>
      `Comment fonctionnent les batailles d'escadron et leurs notes : combien de NPE rapporte une bataille, jusqu'où elle peut monter, comment se calcule la note de l'escadron, quand les points sont mis à jour et ce qui décide d'une bataille. Les règles ont été reconstituées à partir des données publiques de warthunder.com ; les statistiques couvrent toutes les batailles d'escadron de la base de données du bot (${battles}).`,
    quickTitle: "Réponses rapides",
    articlesTitle: "Tous les guides",
    audience: { everyone: "Tous les joueurs", commanders: "Commandants d'escadron", details: "En détail" },
    prev: "Précédent",
    next: "Suivant",
    notFound: "Ce guide n'existe pas",
    upTo: (n) => `jusqu'à ${n}`,
    over: (n) => `plus de ${n}`,
    andMore: (n) => `${n} et plus`,
    minSec: ({ min, sec }) => `${min} min ${sec} s`,
  },
  quick: {
    points: {
      q: "Combien de NPE rapporte une bataille ?",
      a: () => "Votre NPE décide, et l'équipe adverse aussi si sa NPE moyenne dépasse 1500. Contre une équipe d'une moyenne de 1500 ou moins : jusqu'à 780, une victoire rapporte +32 et une défaite −1 ; à 1500, +16 et −16 ; à 2000, +2 et −30.",
    },
    grow: {
      q: "À quelle fréquence faut-il gagner pour que la NPE monte ?",
      a: () => "Plus de 24 batailles sur 100 à une NPE de 1300, plus de la moitié à 1500 et plus de 85 sur 100 à 1800, contre des équipes d'une moyenne de 1500 ou moins. Contre des équipes plus fortes, moins de victoires suffisent.",
    },
    ceiling: {
      q: "Jusqu'où montera ma NPE ?",
      a: () => "Votre taux de victoire en décide : à 50%, la NPE se stabilise vers 1500, à 70% vers 1650, à 90% vers 1880. Jouer souvent contre des équipes d'une moyenne supérieure à 1500 relève ce niveau.",
    },
    factors: {
      q: "L'adversaire et mon jeu en bataille comptent-ils ?",
      a: () => "Votre jeu, non : le score, les frags, les morts et la durée de la bataille ne comptent pas. L'adversaire ne compte que si son équipe a une NPE moyenne supérieure à 1500 : une victoire rapporte alors plus et une défaite coûte moins.",
    },
    leave: {
      q: "Peut-on quitter une bataille perdue sans perdre de NPE ?",
      a: () => "Non. Quitter une bataille coûte autant de NPE qu'une défaite ordinaire.",
    },
    squadron: {
      q: "Quelles batailles font monter la note de l'escadron ?",
      a: () => "Les batailles des 20 meilleurs joueurs de l'escadron, tant que leur NPE reste sous le niveau où elle se stabilise. Un point de n'importe quel autre joueur vaut 20 fois moins pour l'escadron.",
    },
    delay: {
      q: "Quand la NPE est-elle mise à jour après une bataille ?",
      a: ({ delayMin, delayMax, delayMedian }) =>
        `Au bout de ${delayMin} à ${delayMax} minutes, ${delayMedian} en moyenne : les pages de warthunder.com sont régénérées au plus une fois toutes les 15 minutes.`,
    },
    battle: {
      q: "Combien de temps dure une bataille d'escadron ?",
      a: ({ battleMedian, wiped }) =>
        `La moitié des batailles se terminent en moins de ${battleMedian}. Chaque joueur n'a qu'un véhicule, et dans ${wiped} des batailles l'équipe perdante est détruite jusqu'au dernier véhicule.`,
    },
    favorite: {
      q: "L'équipe à la NPE la plus élevée gagne-t-elle ?",
      a: ({ favoriteWins, favoriteElo }) =>
        `Plus souvent, mais pas de beaucoup : avec plus de 400 d'avance, elle gagne ${favoriteWins} des batailles, alors que la formule promet ${favoriteElo}.`,
    },
    accuracy: {
      q: "D'où viennent ces règles et quelle est leur précision ?",
      a: ({ changes, withinOne }) =>
        `Gaijin ne publie pas la formule. Elle a été reconstituée en comparant environ ${changes} variations de NPE avec les résultats des batailles : pour une seule bataille, elle correspond au site du jeu à 1 point près dans ${withinOne} des cas.`,
    },
  },
  articles: {
    psr: {
      title: "Comment fonctionne la NPE",
      summary: "Points par victoire et par défaite, un calculateur, jusqu'où la NPE peut monter et la formule.",
    },
    squadron: {
      title: "Note de l'escadron",
      summary: "Comment elle s'additionne à partir des NPE des joueurs, quelles batailles la font monter, ce que coûte le renvoi d'un membre et ce qu'il faut pour le top 10.",
    },
    updates: {
      title: "Mises à jour et saison",
      summary: "Quand les points apparaissent après une bataille, à quelle fréquence ce site est mis à jour, les dates de la saison et les horaires des batailles d'escadron.",
    },
    battle: {
      title: "Le déroulement d'une bataille d'escadron",
      summary: "Un véhicule par joueur, combien de temps dure une bataille, comment elle se termine et ce qui en décide.",
    },
    stats: {
      title: "Statistiques des batailles d'escadron",
      summary: "Dans quelle mesure les notes prédisent le vainqueur, comment les adversaires sont appariés, combien jouent les escadrons et combien de joueurs atteignent une NPE élevée.",
    },
    method: {
      title: "Méthode de mesure",
      summary: "D'où viennent les données, comment la formule a été établie et quelle est sa précision.",
    },
  },
  psr: {
    lead: "La NPE est la note personnelle d'escadron. Après chaque bataille d'escadron, elle monte en cas de victoire et baisse en cas de défaite. De combien, cela dépend de votre NPE — plus elle est élevée, moins une victoire rapporte et plus une défaite coûte — et de l'équipe adverse si sa NPE moyenne dépasse 1500.",
    points: {
      title: "Points par bataille",
      head: ["NPE", "Victoire", "Défaite", "Taux de victoire"],
      notes: [
        "Le tableau vaut pour une équipe adverse d'une NPE moyenne de 1500 ou moins. Une équipe plus forte compte avec sa moyenne au lieu de 1500 : une victoire rapporte plus et une défaite coûte moins. À une NPE de 1800 contre une équipe d'une moyenne de 1800, une victoire rapporte +16 au lieu de +5 et une défaite −16 au lieu de −27.",
        "**Taux de victoire** — combien de batailles sur 100 il faut gagner pour que la NPE monte. En gagnant moins souvent, elle baisse.",
        "Au-dessus de 903, une victoire et une défaite valent toujours 32 points à elles deux : moins une victoire rapporte, plus une défaite coûte.",
        "Au-dessus de 1500, une défaite coûte plus qu'une victoire ne rapporte : à 1800, une défaite efface 5 à 6 victoires, à 2000 environ 18. Le même bilan — 5 victoires et 5 défaites — donne donc +155 à une NPE de 0, 0 à 1500 et −143 à 2000.",
        "La NPE ne descend jamais sous 0. Le jeu conserve les décimales de la NPE et affiche un nombre entier, si bien qu'une même victoire peut apparaître comme +16 ou +17.",
      ],
    },
    calc: {
      title: "Calculateur",
      intro: "Saisissez votre NPE et votre taux de victoire : le calculateur applique la formule pour une équipe adverse d'une moyenne de 1500 ou moins et montre ce que vous gagnez et jusqu'où vous monterez.",
      psr: "Votre NPE",
      winRate: "Taux de victoire",
      win: "Par victoire",
      loss: "Par défaite",
      hold: "La NPE monte avec un taux de victoire supérieur à",
      per10: "Pour 10 batailles en moyenne",
      ceiling: "La NPE se stabilise vers",
      battles: "Batailles jusqu'à ce niveau",
      fromNow: "depuis votre NPE, en moyenne",
      reached: "vous y êtes déjà",
      above: "vous êtes au-dessus : la NPE baissera en moyenne",
      endless: "sans défaites, la NPE monte sans limite, de plus en plus lentement",
      stuck: "à ce taux de victoire, la NPE ne monte pas",
      note: "Ce sont des moyennes : les vraies séries de victoires et de défaites se dispersent autour.",
    },
    factors: {
      title: "Ce qui influe sur la NPE",
      items: [
        "**La force de l'adversaire — seulement au-delà de 1500.** La formule vous compare à la NPE moyenne de l'équipe adverse, mais jamais à moins de 1500. Une victoire contre toute équipe d'une moyenne de 1500 ou moins vaut la même chose ; contre une équipe plus forte, une victoire rapporte plus et une défaite coûte moins.",
        "**Le jeu en bataille — aucun effet.** Le score, les frags, les morts et la durée de la bataille ne comptent pas. La NPE change pour toute l'équipe : le meilleur joueur, ceux qui se sont déconnectés et ceux qui n'ont pas chargé.",
        "**Quitter la bataille ne sauve rien.** Si vous quittez une bataille perdue, vous perdez autant de NPE que pour une défaite ordinaire.",
        "**Le rôle dans l'escadron — aucun effet.** Le commandant, un officier et un soldat reçoivent la même chose.",
        "**Votre propre NPE compte le plus.** Pour une victoire contre une équipe d'une moyenne de 1500 ou moins, un joueur à 0 de NPE reçoit +32 et un joueur à 1800 reçoit +5.",
      ],
    },
    ceiling: {
      title: "Jusqu'où la NPE peut monter",
      intro: "Plus la NPE est élevée, moins une victoire rapporte : la NPE se stabilise donc à un niveau fixé par votre taux de victoire. Avec 50% de victoires, elle atteint 1500 puis oscille autour. Jouer plus ne relève pas ce niveau — vous l'atteignez seulement plus vite. Le tableau vaut pour des équipes adverses d'une moyenne de 1500 ou moins ; des adversaires plus forts relèvent le niveau : avec 50% de victoires, c'est leur NPE moyenne.",
      head: ["Taux de victoire", "La NPE se stabilise vers", "Batailles depuis zéro"],
      notes: [
        "**Batailles depuis zéro** — combien de batailles depuis le début de la saison il faut pour arriver à moins de 50 points de ce niveau. Une série chanceuse peut vous faire monter plus haut, mais la NPE redescend ensuite.",
        "C'est pourquoi la NPE reflète plus le nombre de batailles que le niveau de jeu : 100 batailles à 40% de victoires donnent environ 1170, alors que 20 batailles à 80% donnent environ 510.",
      ],
      streaks: "Même sans défaites, la progression ralentit :",
      streakHead: ["De NPE", "À NPE", "Victoires d'affilée"],
    },
    season: {
      title: "Début de saison et pauses",
      body: [
        "Au début d'une saison, tout le monde a une NPE de 0. Sous 903, une défaite ne coûte que 1 point alors qu'une victoire en rapporte 31 ou 32 : au début, la NPE monte donc presque uniquement avec le nombre de victoires. Atteindre 903 prend environ 42 batailles à 70% de victoires, 59 à 50% et 103 à 30%. **En début de saison, jouer beaucoup compte donc plus** que gagner souvent.",
        "Sans batailles, la NPE ne change pas et reste jusqu'à la fin de la saison. Si une série chanceuse vous a fait dépasser votre niveau, chaque bataille suivante coûte des points en moyenne, une pause non.",
      ],
    },
    formula: {
      title: "Formule",
      win: "Victoire",
      loss: "Défaite",
      atLeast: (n) => `au moins ${n}`,
      floor: "La NPE ne descend jamais sous 0",
      opponent: (n) => ["NPE moyenne de l'équipe", `adverse, au moins ${n}`],
      body: [
        "**E** est la part de victoires à laquelle la NPE ne bouge pas : la colonne « Taux de victoire » du [tableau](/guides/psr#points), qui utilise R = 1500. Sous 903, la formule retirerait moins de 1 point pour une défaite, c'est donc toujours −1 et 3% de victoires suffisent pour monter.",
        "Exemple pour une NPE de 1300 contre une équipe d'une moyenne de 1500 ou moins : x = (1500 − 1300) / 400 = 0,5 ; 10^0,5 ≈ 3,16 ; E = 1 / 4,16 ≈ 0,24. Victoire : 32 × 0,76 ≈ +24. Défaite : 32 × 0,24 ≈ −8.",
        "Au-dessus de 903, le résultat moyen d'une bataille se calcule plus simplement : 32 × (part de victoires − E). Pour une NPE de 1300 et 60% de victoires, cela donne 32 × (0,60 − 0,24) ≈ +11,5 par bataille.",
        "C'est le système Elo, comme aux échecs, où l'adversaire est la NPE moyenne de l'équipe adverse. Une équipe plus faible compte pour 1500 : la battre rapporte autant que battre une équipe d'une moyenne de 1500.",
      ],
    },
  },
  squadron: {
    lead: "La note de l'escadron additionne les NPE de ses joueurs, mais pas à parts égales : les 20 meilleurs comptent en entier, les autres à 5%. Cela explique quelles batailles aident l'escadron et pourquoi la place au classement dépend du nombre de batailles. Sur ce site, les notes des escadrons se trouvent dans [Escadrons](/clans).",
    formula: {
      title: "Comment elle est calculée",
      line: ({ top, share }) => `Note de l'escadron = NPE des ${top} meilleurs + ${share} des NPE des autres`,
      body: ["Un escadron compte jusqu'à 128 joueurs. C'est l'effectif actuel qui compte : les membres inactifs restent dans la note, et la NPE de ceux qui partent s'en va avec eux."],
    },
    top20: {
      title: "Les 20 meilleurs décident",
      body: [
        "Un point d'un joueur du top 20 vaut 20 fois plus pour l'escadron. Une victoire d'un joueur du top 20 à 1500 de NPE rapporte +16 à l'escadron ; le même joueur hors du top 20 rapporte +0,8.",
        "Une équipe de 8 joueurs du top 20 à environ 1500 rapporte à l'escadron +128 par victoire et −128 par défaite.",
        "Quand un joueur dépasse le 20e, il se met à compter en entier, et celui qu'il évince compte à 5%. Dès lors, chaque point du nouveau joueur va en entier à l'escadron.",
      ],
    },
    who: {
      title: "Quelles batailles rapportent des points",
      intro: "Tant que la NPE d'un joueur reste sous le niveau où elle se stabilise à son taux de victoire (le tableau « [Jusqu'où la NPE peut monter](/guides/psr#ceiling) »), ses batailles rapportent en moyenne des points à l'escadron. Au-dessus, elles en retirent, même si le joueur joue bien :",
      head: ["NPE du joueur", "Taux de victoire", "En moyenne pour 10 batailles"],
      notes: [
        "Des joueurs à 1300 et à 1600 gagnent aussi souvent, mais le premier rapporte des points à l'escadron et le second lui en fait perdre : à 60% de victoires, la NPE se stabilise à 1570. Si deux joueurs sont aussi forts l'un que l'autre, l'escadron gagne plus en alignant celui dont la NPE est la plus basse — tant que ce choix ne réduit pas les chances de victoire de l'équipe.",
        "La NPE ne baisse pas sans batailles : un joueur au-dessus de son niveau conserve les points de l'escadron tant qu'il ne joue pas.",
      ],
    },
    roster: {
      title: "Autres membres et nettoyage de l'effectif",
      body: [
        "Les membres hors des 20 meilleurs rapportent aussi des points, 5% de leur NPE chacun : 100 joueurs à 1000 de NPE ajoutent 5 000, à peu près autant que trois joueurs du top 20.",
        "Renvoyer un membre coûte donc des points. Un membre hors du top 20 à 1000 de NPE emporte 50 points. Un membre du top 20 emporte sa NPE, mais le 21e prend sa place et se met à compter en entier : l'escadron perd la NPE du partant moins 95% de celle du 21e. Par exemple, un joueur à 1800 part et le 21e a 1500 : l'escadron perd 1800 − 1425 = 375.",
      ],
    },
    ceiling: {
      title: "Plafond de l'escadron",
      intro: "Une fois que les 20 meilleurs ont atteint leurs niveaux, la note de l'escadron ne monte plus avec le nombre de batailles, seulement avec le taux de victoire :",
      head: ["Taux de victoire des 20 meilleurs", "NPE de chacun", "Somme des 20 meilleurs"],
      notes: ({ battlesLow, battlesHigh, hoursLow, hoursHigh }) => [
        `Plus 5% des NPE des autres. Chacun des 20 meilleurs a besoin de ${battlesLow} à ${battlesHigh} batailles pour atteindre son niveau : au [rythme habituel](/guides/battle#length), cela fait ${hoursLow} à ${hoursHigh} heures de batailles d'escadron. D'ici là, la note de l'escadron monte aussi avec le nombre de batailles.`,
        "Les séries chanceuses et les joueurs à NPE élevée qui ont arrêté de jouer peuvent maintenir un escadron au-dessus de ce niveau : sans batailles, la NPE ne baisse pas.",
      ],
    },
    live: {
      title: "Le classement en ce moment",
      updated: (when) => `au ${when}`,
      places: "Ce qu'il faut pour une place au classement :",
      placesHead: ["Place", "Note de l'escadron"],
      groups: "Moyennes des escadrons à ces places :",
      groupsHead: ["Places", "Taux de victoire", "Batailles de la saison", "Joueurs"],
      conclusion: ({ times }) => `Les escadrons classés de 1 à 10 ont joué ${times} fois plus de batailles que ceux classés de 51 à 100.`,
      note: "Données du classement officiel de warthunder.com.",
      empty: "Le classement est indisponible pour le moment.",
    },
  },
  updates: {
    lead: "La NPE change juste après la bataille, mais les pages de warthunder.com l'affichent jusqu'à 15 minutes plus tard. Ici : d'où vient ce délai, à quelle fréquence ce site est mis à jour, les dates de la saison et les horaires des batailles d'escadron.",
    delay: {
      title: "Quand les points apparaissent",
      body: ({ min, max, median }) => [
        "Le jeu enregistre le résultat d'une bataille environ 30 secondes après sa fin. Mais les pages d'escadron et le classement sur warthunder.com ne l'affichent pas tout de suite : le site du jeu en garde une copie pendant 15 minutes et en génère une nouvelle à la première requête qui suit.",
        `La nouvelle NPE apparaît donc ${min} à ${max} minutes après la bataille, ${median} en moyenne. Recharger plus souvent ne sert à rien : tant que la copie a moins de 15 minutes, le site du jeu l'affiche. Si plus de 15 minutes se sont écoulées depuis la fin de la bataille, rechargez la page de l'escadron : elle affichera le résultat.`,
        "Les batailles jouées pendant ces 15 minutes apparaissent ensemble. Elles sont appliquées une par une dans l'ordre de leur fin, chacune à partir de la NPE obtenue après la précédente.",
        "Le classement fonctionne de la même façon, mais chacune de ses pages (20 escadrons) est mise à jour séparément, indépendamment des pages d'escadron. Le classement et la page d'un escadron peuvent donc afficher un moment des notes différentes.",
      ],
    },
    site: {
      title: "Mise à jour de ce site",
      body: [
        "Ce site reprend les notes et les places des escadrons du classement de warthunder.com : le top 100 toutes les 20 minutes, les autres toutes les 12 heures. Avec la copie de 15 minutes sur warthunder.com, les notes des leaders ont ici en général au plus 35 minutes de retard sur le jeu.",
        "La NPE des joueurs provient des pages d'escadron : le bot lit la page d'un escadron quand il publie une bataille avec cet escadron, et parcourt une fois par jour les effectifs des 100 premiers escadrons. La NPE d'un joueur peut donc avoir ici du retard sur le jeu.",
      ],
    },
    season: {
      title: "Saison",
      body: ["Au début d'une saison, la NPE de chaque joueur et la note de chaque escadron reviennent à zéro. La saison est divisée en étapes, chacune avec son propre BR maximal des véhicules :"],
    },
    hours: {
      title: "Horaires des batailles d'escadron",
      body: ({ first, second, peak, firstShare, firstPsr, secondPsr }) => [
        `Les batailles d'escadron ont lieu chaque jour sur deux créneaux (à votre heure locale) : ${first} et ${second}. Le premier créneau concentre ${firstShare} de toutes les batailles, et les heures les plus chargées sont ${peak}.`,
        `Les adversaires sont un peu plus forts sur le second créneau : la NPE moyenne d'une équipe y est typiquement de ${secondPsr}, contre ${firstPsr} sur le premier.`,
      ],
    },
  },
  battle: {
    lead: ({ battles }) =>
      `Toutes les batailles d'escadron sont en 8 contre 8, Réaliste, Domination. Ici : comment elles se déroulent et ce qui en décide, sur toutes les batailles d'escadron de la base de données du bot (${battles}).`,
    vehicles: {
      title: "Un véhicule par bataille",
      body: ({ aircraft, none, four }) => [
        "En bataille d'escadron, chaque joueur n'a qu'un véhicule. S'il est détruit, le joueur est éliminé jusqu'à la fin de la bataille, et l'équipe continue sans lui.",
        `${aircraft} des véhicules engagés sont des avions et des hélicoptères, les autres sont des véhicules terrestres. Le plus souvent, une équipe ne prend aucun avion (c'est le cas de ${none} des équipes) ou en prend quatre (${four}). Plus de quatre, cela n'arrive presque jamais.`,
      ],
    },
    length: {
      title: "Combien de temps dure une bataille",
      body: ({ median, p90, over10, firstKill, gap, series, perHour }) => [
        `La moitié des batailles se terminent en moins de ${median}, neuf sur dix en moins de ${p90}. Seules ${over10} des batailles durent plus de 10 minutes. Le premier véhicule est en général détruit ${firstKill} après le début.`,
        `La bataille suivante commence en général ${gap} après la fin de la précédente. Une série typique compte ${series} batailles d'affilée, et une heure de jeu donne à une escouade ${perHour} batailles en moyenne, pauses comprises.`,
      ],
    },
    ending: {
      title: "Comment se termine une bataille",
      body: ({ wiped, captured, onlyAircraft, survivors }) => [
        `Dans ${wiped} des batailles, l'équipe perdante est détruite jusqu'au dernier véhicule.`,
        `Dans les autres, les perdants avaient encore des véhicules mais ont perdu sur les zones : dans ${captured} de ces batailles, les vainqueurs ont capturé plus de zones. Le plus souvent, il ne restait aux perdants que des avions (${onlyAircraft} de ces batailles), et les avions ne capturent pas les zones.`,
        `La victoire coûte cher aussi : chez les vainqueurs, en général ${survivors} joueurs sur 8 sont encore en vie à la fin.`,
      ],
    },
    decides: {
      title: "Ce qui décide d'une bataille",
      intro: "À quelle fréquence gagne une équipe qui a :",
      head: ["L'équipe a", "Victoires"],
      rows: {
        moreKills: "Plus de frags que l'adversaire",
        firstKill: "Le premier frag de la bataille",
        fewerKills: "Moins de frags que l'adversaire",
        notLoaded: "Un joueur non chargé de plus",
        bot: "Un bot à la place d'un joueur non chargé",
        psr: ({ gap }) => `Une NPE moyenne supérieure de ${gap} ou plus`,
        squadron: ({ gap }) => `Une note d'escadron supérieure de ${gap} ou plus`,
      },
      notes: ({ withFirst, withoutFirst, notLoadedBattles, botWins, botBattles, aircraft, aircraftKills, spread }) => [
        `**Le premier frag** compte, et pas seulement parce que ce sont en général les plus forts qui le font. Même un escadron qui gagne la moitié de ses batailles en gagne ${withFirst} avec le premier frag et ${withoutFirst} sans lui.`,
        "**Avec moins de frags**, une équipe perd presque toujours, et ses rares victoires viennent en général des zones.",
        `**Un joueur non chargé**, c'est presque une défaite (${notLoadedBattles} batailles de ce type dans les données). Le plus souvent, un bot prend sa place, mais même avec lui l'équipe ne gagne que ${botWins} batailles sur ${botBattles}.`,
        `**L'aviation.** Les avions et les hélicoptères représentent ${aircraft} des véhicules, mais réalisent ${aircraftKills} des frags. Pourtant, la victoire ne dépend presque pas de leur nombre : le taux de victoire d'un même escadron, avec n'importe quel nombre d'avions de 0 à 4, ne s'écarte pas de son taux habituel de plus de ${spread}.`,
        "Pour savoir dans quelle mesure les notes prédisent le vainqueur, voir les [statistiques](/guides/stats#psr).",
      ],
    },
    sides: {
      title: "Côtés de la carte",
      body: ({ team1, team2, maps, minBattles, low, high }) => [
        `Le côté de la carte ne donne aucun avantage : les équipes 1 et 2 ont gagné presque autant (${team1} et ${team2}). Sur chaque carte de plus de ${minBattles} batailles (${maps} cartes), le premier côté gagne de ${low} à ${high} des batailles, dans les limites du hasard.`,
      ],
    },
  },
  stats: {
    lead: ({ battles, date }) =>
      `Batailles d'escadron dans la base de données du bot au ${date} : ${battles}. Toutes sont en 8 contre 8, Réaliste, Domination.`,
    psr: {
      title: "Dans quelle mesure la NPE prédit le vainqueur",
      intro: "L'équipe dont la NPE moyenne est la plus élevée gagne plus souvent, mais bien moins souvent que ne le promet la formule :",
      head: ["Écart de NPE moyenne des équipes", "L'équipe à la NPE la plus élevée gagne", "Selon la formule de la NPE", "Batailles"],
      notes: [
        "**Selon la formule de la NPE** — à quelle fréquence l'équipe gagnerait si la NPE mesurait exactement la force. L'avantage réel est plus faible : la NPE monte avec le nombre de batailles, pas seulement avec le niveau de jeu ([pourquoi](/guides/psr#ceiling)). Le taux de victoire d'un joueur en dit plus sur sa force.",
      ],
    },
    squadron: {
      title: "Dans quelle mesure la note de l'escadron prédit le vainqueur",
      head: ["Écart de note d'escadron", "L'escadron le mieux noté gagne", "Batailles"],
      notes: ({ even, strong, strongWins }) => [
        `Avec un écart jusqu'à ${even}, chacun des deux escadrons gagne à peu près aussi souvent. Ce n'est qu'au-delà de ${strong} d'écart que l'escadron le mieux noté gagne ${strongWins} des batailles : la note monte avec le nombre de batailles, et seuls 8 joueurs combattent dans une bataille, pas forcément les plus forts.`,
      ],
    },
    matchmaking: {
      title: "Appariement des adversaires",
      body: ({ psrReal, psrRandom, squadronReal, squadronRandom, repeat, opponents }) => [
        `L'appariement tient peu compte des notes. La NPE moyenne des équipes d'une bataille diffère typiquement de ${psrReal}, alors que deux équipes prises au hasard ayant joué dans les mêmes 2 heures diffèrent de ${psrRandom}. Pour la note des escadrons, c'est ${squadronReal} contre ${squadronRandom}. Un adversaire avec 200 de NPE de plus ou de moins est normal.`,
        `Les adversaires reviennent souvent : sur un même [créneau de batailles d'escadron](/guides/updates#hours), ${repeat} des batailles d'un escadron l'opposent à un escadron qu'il a déjà affronté sur ce créneau. Sur 10 batailles d'affilée, il rencontre en moyenne ${opponents} adversaires différents.`,
      ],
    },
    distribution: {
      title: "Combien de joueurs atteignent une NPE élevée",
      intro: ({ players, zero }) =>
        `Joueurs d'escadron dont le bot a vu la NPE cette saison : ${players}. ${zero} d'entre eux ont une NPE de 0 : ils n'ont pas encore gagné cette saison. Parmi les autres :`,
      head: ["NPE", "Part des joueurs"],
      notes: ({ median, top10, top1, max }) => [
        `La moitié d'entre eux est sous ${median}. Les 10% meilleurs commencent à ${top10}, les 1% meilleurs à ${top1}. La NPE la plus élevée vue par le bot est ${max}.`,
      ],
    },
    activity: {
      title: "Combien jouent les escadrons",
      intro: ({ from, to }) => `Une journée ordinaire de cette saison — moyennes sur les journées complètes du ${from} au ${to} :`,
      head: ["Par jour", "En moyenne"],
      rows: {
        battles: "Batailles d'escadron",
        squadrons: "Escadrons en bataille",
        players: "Joueurs en bataille",
        squadronDay: "Batailles d'un escadron",
        playerDay: "Batailles d'un joueur",
      },
      notes: ({ low, high, topLow, topHigh, from, to, playersLow, playersHigh }) => [
        `Batailles par jour : de ${low} à ${high}. Un escadron ou un joueur ne compte que les jours où il a joué.`,
        `Les 10 escadrons les plus actifs jouent de ${topLow} à ${topHigh} batailles par jour et, du ${from} au ${to}, ont aligné chacun de ${playersLow} à ${playersHigh} joueurs différents. Seuls les 20 meilleurs d'entre eux comptent en entier dans la note de l'escadron ([pourquoi](/guides/squadron#top20)).`,
      ],
    },
  },
  method: {
    lead: "Gaijin ne publie pas la formule de la NPE. Les règles de ces guides ont été reconstituées à partir des données publiques de warthunder.com et vérifiées sur des batailles réelles. Ce ne sont pas des données officielles : Gaijin peut changer les règles à tout moment, et les chiffres de ces guides seront alors dépassés.",
    data: {
      title: "Données",
      body: ({ date, battles, changes, psrBattles, squadronBattles, from1, to1, from2, to2 }) => [
        `Le bot collecte la NPE des membres des escadrons et le classement des escadrons sur les pages de warthunder.com, et dans les replays des batailles, qui a joué, sur quel véhicule, qui a détruit qui, qui a capturé les zones et qui a gagné. Au ${date}, la base de données contient ${battles} batailles d'escadron et ${changes} variations de NPE. Les batailles vont du ${from1} au ${to1} et du ${from2} au ${to2} : les autres jours, le bot ne les a pas collectées.`,
        `Les comparaisons de NPE des équipes utilisent les batailles où la NPE d'au moins 6 des 8 joueurs de chaque équipe est connue (${psrBattles}) ; les comparaisons d'escadrons utilisent les batailles où les notes des deux escadrons sont connues (${squadronBattles}).`,
      ],
    },
    formula: {
      title: "Formule de la NPE",
      body: ({ single, k, reference, scale, withinOne, chainLow, chainHigh, liveMatched, liveTotal, max, strong, fixed, enemy, weaker }) => [
        `La formule a été établie sur les cas où exactement une bataille séparait deux relevés de la NPE d'un joueur (${single}). C'est le système Elo qui correspondait le mieux. Les valeurs obtenues (${k} ; ${reference} ; ${scale}) correspondent à 32, 1500 et 400.`,
        `Pour une seule bataille, la formule correspond au site du jeu à 1 point près dans ${withinOne} des cas. Elle explique de ${chainLow} à ${chainHigh} des variations couvrant plusieurs batailles, selon la NPE. Lors d'une vérification en direct, ${liveMatched} variations sur ${liveTotal} correspondaient.`,
        `Une vérification plus large en octobre 2026 a montré qu'un adversaire fort compte bel et bien. Sur ${strong} variations d'une seule bataille contre une équipe d'une NPE moyenne supérieure à 1500, un adversaire fixe de 1500 correspondait au site du jeu à 1 point près dans seulement ${fixed} des cas, la NPE moyenne de l'équipe adverse dans ${enemy}. Contre des équipes plus faibles, les deux donnent ${weaker} : l'adversaire ne compte jamais comme plus faible que 1500.`,
        `Vérifiée sur des NPE de 0 à ${max}, la NPE la plus élevée des données ; au-delà, il n'y a rien sur quoi vérifier la formule.`,
      ],
    },
    squadron: {
      title: "Note de l'escadron",
      body: ({ states, errorLow, errorHigh }) => [
        `La formule de la note de l'escadron a été vérifiée sur ${states} états de pages d'escadron : l'écart était de ${errorLow} à ${errorHigh} points, les décimales de la NPE que le site du jeu n'affiche pas.`,
      ],
    },
    timing: {
      title: "Délai de mise à jour",
      body: ({ date, from, to, poll, squadrons, battles, min, max, median, fresh, timer }) => [
        `Le ${date}, de ${from} à ${to} UTC, le bot a lu les pages de ${squadrons} escadrons toutes les ${poll} secondes pendant leurs batailles. Sur ${battles} batailles, le résultat est apparu ${min} à ${max} minutes après la fin de la bataille, ${median} en moyenne.`,
        `Les mises à jour des pages arrivaient à exactement 15 minutes d'intervalle, et la première requête après une pause obtenait des données fraîches dans ${fresh} des cas ; une page actualisée à heure fixe en donnerait environ ${timer}. La page est donc régénérée à la demande dès que sa copie a plus de 15 minutes.`,
      ],
    },
    code: {
      title: "Code",
      body: ({ url }) => [`La formule et chaque tableau de ces guides sont calculés dans le code source ouvert du site : [lib/psr.ts](${url}).`],
    },
  },
}
