import type { GuideText } from './types'

// Spanish guide text: terms of i18n/es.ts (CPE, escuadrón, clasificación del escuadrón); "tú", as the dictionary.
export const es: GuideText = {
  term: 'CPE',
  ui: {
    title: 'Guías',
    lead: ({ battles }) =>
      `Cómo funcionan las batallas de escuadrón y sus clasificaciones: cuánta CPE da una batalla, hasta dónde puede subir, cómo se calcula la clasificación del escuadrón, cuándo se actualizan los puntos y qué decide una batalla. Las reglas se reconstruyeron a partir de datos públicos de warthunder.com; las estadísticas abarcan todas las batallas de escuadrón de la base de datos del bot (${battles}).`,
    quickTitle: 'Respuestas rápidas',
    articlesTitle: 'Todas las guías',
    audience: { everyone: 'Todos los jugadores', commanders: 'Comandantes de escuadrón', details: 'En detalle' },
    prev: 'Anterior',
    next: 'Siguiente',
    notFound: 'No existe esta guía',
    upTo: (n) => `hasta ${n}`,
    over: (n) => `más de ${n}`,
    andMore: (n) => `${n} o más`,
    minSec: ({ min, sec }) => `${min} min ${sec} s`,
  },
  quick: {
    points: {
      q: '¿Cuánta CPE da una batalla?',
      a: () => 'Depende de tu CPE y, si la CPE media del equipo rival supera 1500, también de él. Contra un equipo con una media de 1500 o menos: hasta 780, una victoria da +32 y una derrota −1; con 1500, +16 y −16; con 2000, +2 y −30.',
    },
    grow: {
      q: '¿Con qué frecuencia tengo que ganar para que suba la CPE?',
      a: () => 'Más de 24 batallas de cada 100 con 1300 de CPE, más de la mitad con 1500 y más de 85 de cada 100 con 1800, contra equipos con una media de 1500 o menos. Contra equipos más fuertes bastan menos victorias.',
    },
    ceiling: {
      q: '¿Hasta dónde subirá mi CPE?',
      a: () => 'Lo decide tu % de victorias: con el 50%, la CPE se estanca en torno a 1500; con el 70%, en torno a 1650; con el 90%, en torno a 1880. Jugar a menudo contra equipos con una media de más de 1500 sube ese nivel.',
    },
    factors: {
      q: '¿Influyen el rival y mi juego en la batalla?',
      a: () => 'Tu juego, no: la puntuación, las bajas, las muertes y la duración de la batalla no cuentan. El rival solo cuenta si su equipo tiene una CPE media de más de 1500: entonces una victoria da más y una derrota quita menos.',
    },
    leave: {
      q: '¿Puedo salir de una batalla perdida sin perder CPE?',
      a: () => 'No. Salir de la batalla quita la misma CPE que una derrota normal.',
    },
    squadron: {
      q: '¿Qué batallas suben la clasificación del escuadrón?',
      a: () => 'Las batallas de los 20 mejores jugadores del escuadrón, mientras su CPE esté por debajo del nivel en el que se estanca. Un punto de cualquier otro jugador vale 20 veces menos para el escuadrón.',
    },
    delay: {
      q: '¿Cuándo se actualiza la CPE tras una batalla?',
      a: ({ delayMin, delayMax, delayMedian }) =>
        `En ${delayMin}–${delayMax} minutos, ${delayMedian} de media: las páginas de warthunder.com se regeneran como mucho una vez cada 15 minutos.`,
    },
    battle: {
      q: '¿Cuánto dura una batalla de escuadrón?',
      a: ({ battleMedian, wiped }) =>
        `La mitad de las batallas terminan en menos de ${battleMedian}. Cada jugador tiene un solo vehículo, y en el ${wiped} de las batallas el equipo perdedor queda destruido hasta el último vehículo.`,
    },
    favorite: {
      q: '¿Gana el equipo con más CPE?',
      a: ({ favoriteWins, favoriteElo }) =>
        `Más a menudo, pero no por mucho: con más de 400 de ventaja gana el ${favoriteWins} de las batallas, mientras que la fórmula promete el ${favoriteElo}.`,
    },
    accuracy: {
      q: '¿De dónde salen estas reglas y qué precisión tienen?',
      a: ({ changes, withinOne }) =>
        `Gaijin no publica la fórmula. Se reconstruyó comparando unos ${changes} cambios de CPE con los resultados de las batallas: para una sola batalla coincide con la web del juego con un margen de 1 punto en el ${withinOne} de los casos.`,
    },
  },
  articles: {
    psr: {
      title: 'Cómo funciona la CPE',
      summary: 'Puntos por victoria y por derrota, una calculadora, hasta dónde puede subir la CPE y la fórmula.',
    },
    squadron: {
      title: 'Clasificación del escuadrón',
      summary: 'Cómo se suma a partir de la CPE de los jugadores, qué batallas la suben, cuánto cuesta expulsar a un miembro y qué hace falta para el top 10.',
    },
    updates: {
      title: 'Actualizaciones y temporada',
      summary: 'Cuándo aparecen los puntos tras una batalla, cada cuánto se actualiza este sitio, las fechas de la temporada y los horarios de las batallas de escuadrón.',
    },
    battle: {
      title: 'Cómo es una batalla de escuadrón',
      summary: 'Un vehículo por jugador, cuánto dura una batalla, cómo termina y qué la decide.',
    },
    stats: {
      title: 'Estadísticas de batallas de escuadrón',
      summary: 'Hasta qué punto las clasificaciones predicen al ganador, cómo se emparejan los rivales, cuánto juegan los escuadrones y cuántos jugadores alcanzan una CPE alta.',
    },
    method: {
      title: 'Cómo se midió',
      summary: 'De dónde salen los datos, cómo se ajustó la fórmula y qué precisión tiene.',
    },
  },
  psr: {
    lead: 'La CPE es la clasificación personal de escuadrón. Tras cada batalla de escuadrón sube si ganas y baja si pierdes. Cuánto depende de tu CPE (cuanto más alta es, menos da una victoria y más quita una derrota) y del equipo rival, si su CPE media supera 1500.',
    points: {
      title: 'Puntos por batalla',
      head: ['CPE', 'Victoria', 'Derrota', '% de victorias'],
      notes: [
        'La tabla es para un equipo rival con una CPE media de 1500 o menos. Un equipo más fuerte cuenta con su media en lugar de 1500: una victoria da más y una derrota quita menos. Con 1800 de CPE contra un equipo con una media de 1800, una victoria da +16 en lugar de +5 y una derrota −16 en lugar de −27.',
        '**% de victorias** — cuántas batallas de cada 100 tienes que ganar para que la CPE suba. Si ganas menos, baja.',
        'Por encima de 903, una victoria y una derrota valen siempre 32 puntos entre las dos: cuanto menos da una victoria, más quita una derrota.',
        'Por encima de 1500 una derrota quita más de lo que da una victoria: con 1800 una derrota anula 5–6 victorias; con 2000, unas 18. Por eso el mismo balance —5 victorias y 5 derrotas— da +155 con 0 de CPE, 0 con 1500 y −143 con 2000.',
        'La CPE nunca baja de 0. El juego guarda los decimales de la CPE y muestra un número entero, así que la misma victoria puede verse como +16 o +17.',
      ],
    },
    calc: {
      title: 'Calculadora',
      intro: 'Introduce tu CPE y tu % de victorias: la calculadora aplica la fórmula para un equipo rival con una media de 1500 o menos y muestra lo que obtienes y hasta dónde subirás.',
      psr: 'Tu CPE',
      winRate: '% de victorias',
      win: 'Por victoria',
      loss: 'Por derrota',
      hold: 'La CPE sube si ganas más del',
      per10: 'Cada 10 batallas, de media',
      ceiling: 'La CPE se estanca en torno a',
      battles: 'Batallas hasta ese nivel',
      fromNow: 'desde tu CPE, de media',
      reached: 'ya estás ahí',
      above: 'estás por encima: la CPE bajará de media',
      endless: 'sin derrotas la CPE sube sin límite, cada vez más despacio',
      stuck: 'con este % de victorias la CPE no sube',
      note: 'Son medias: las rachas reales de victorias y derrotas se dispersan a su alrededor.',
    },
    factors: {
      title: 'Qué influye en la CPE',
      items: [
        '**La fuerza del rival: solo por encima de 1500.** La fórmula te compara con la CPE media del equipo rival, pero nunca con menos de 1500. Una victoria contra cualquier equipo con una media de 1500 o menos vale lo mismo; contra uno más fuerte, una victoria da más y una derrota quita menos.',
        '**El juego en la batalla: no influye.** La puntuación, las bajas, las muertes y la duración de la batalla no cuentan. La CPE cambia para todo el equipo: para el mejor jugador, para los que se desconectaron y para los que no cargaron.',
        '**Salir de la batalla no sirve.** Si sales de una batalla perdida, pierdes la misma CPE que en una derrota normal.',
        '**El rango en el escuadrón: no influye.** El comandante, un oficial y un soldado reciben lo mismo.',
        '**Lo que más cuenta es tu CPE.** Por una victoria contra un equipo con una media de 1500 o menos, un jugador con 0 de CPE recibe +32 y uno con 1800 recibe +5.',
      ],
    },
    ceiling: {
      title: 'Hasta dónde puede subir la CPE',
      intro: 'Cuanto más alta es la CPE, menos da una victoria, así que la CPE se estanca en un nivel que depende de tu % de victorias. Con el 50% de victorias llega a 1500 y luego oscila a su alrededor. Jugar más no sube ese nivel: solo te lleva antes a él. La tabla es para equipos rivales con una media de 1500 o menos; los rivales más fuertes suben el nivel: con el 50% de victorias es su CPE media.',
      head: ['% de victorias', 'La CPE se estanca en torno a', 'Batallas desde cero'],
      notes: [
        '**Batallas desde cero** — cuántas batallas desde el inicio de la temporada hacen falta para quedar a menos de 50 puntos de ese nivel. Una racha de suerte puede subirte más, pero luego la CPE vuelve.',
        'Por eso la CPE refleja más el número de batallas que la habilidad: 100 batallas con el 40% de victorias dan unos 1170, mientras que 20 batallas con el 80% dan unos 510.',
      ],
      streaks: 'Incluso sin derrotas, la subida se frena:',
      streakHead: ['Desde CPE', 'Hasta CPE', 'Victorias seguidas'],
    },
    season: {
      title: 'Inicio de temporada y pausas',
      body: [
        'Al inicio de la temporada todos tienen 0 de CPE. Por debajo de 903 una derrota solo quita 1 punto y una victoria da 31–32, así que al principio la CPE sube casi solo con el número de victorias. Llegar a 903 lleva unas 42 batallas con el 70% de victorias, 59 con el 50% y 103 con el 30%. **Al inicio de la temporada importa más jugar mucho** que ganar a menudo.',
        'Sin batallas la CPE no cambia y se mantiene hasta el final de la temporada. Si una racha de suerte te subió por encima de tu nivel, cada batalla siguiente quita puntos de media; una pausa, no.',
      ],
    },
    formula: {
      title: 'Fórmula',
      win: 'Victoria',
      loss: 'Derrota',
      atLeast: (n) => `como mínimo ${n}`,
      floor: 'La CPE nunca baja de 0',
      opponent: (n) => ['CPE media del equipo rival,', `como mínimo ${n}`],
      body: [
        '**E** es la proporción de victorias con la que la CPE no se mueve: la columna «% de victorias» de la [tabla](/guides/psr#points), que usa R = 1500. Por debajo de 903 la fórmula quitaría menos de 1 punto por derrota, así que ahí siempre es −1 y basta con el 3% de victorias para subir.',
        'Ejemplo con 1300 de CPE contra un equipo con una media de 1500 o menos: x = (1500 − 1300) / 400 = 0,5; 10^0,5 ≈ 3,16; E = 1 / 4,16 ≈ 0,24. Victoria: 32 × 0,76 ≈ +24. Derrota: 32 × 0,24 ≈ −8.',
        'Por encima de 903, el resultado medio de una batalla se calcula más fácil: 32 × (proporción de victorias − E). Con 1300 de CPE y el 60% de victorias son 32 × (0,60 − 0,24) ≈ +11,5 por batalla.',
        'Es el sistema Elo, como en el ajedrez, en el que el rival es la CPE media del equipo contrario. Un equipo más débil cuenta como 1500, así que ganarle da lo mismo que ganar a un equipo con una media de 1500.',
      ],
    },
  },
  squadron: {
    lead: 'La clasificación del escuadrón suma la CPE de sus jugadores, pero no por igual: la de los 20 mejores cuenta completa y la del resto, al 5%. Esto explica qué batallas ayudan al escuadrón y por qué el puesto en la tabla depende del número de batallas. En este sitio, las clasificaciones de los escuadrones están en [Escuadrones](/clans).',
    formula: {
      title: 'Cómo se calcula',
      line: ({ top, share }) => `Clasificación del escuadrón = CPE de los ${top} mejores + ${share} de la CPE del resto`,
      body: ['Un escuadrón tiene hasta 128 jugadores. Cuenta la plantilla actual: los miembros inactivos siguen en la clasificación, y la CPE de quienes se van se va con ellos.'],
    },
    top20: {
      title: 'Deciden los 20 mejores',
      body: [
        'Un punto de un jugador del top 20 vale 20 veces más para el escuadrón. Una victoria de un jugador del top 20 con 1500 de CPE da al escuadrón +16; el mismo jugador fuera del top 20 da +0,8.',
        'Un equipo de 8 jugadores del top 20 con unos 1500 da al escuadrón +128 por victoria y −128 por derrota.',
        'Cuando un jugador supera al 20.º, empieza a contar completo, y el desplazado cuenta al 5%. A partir de entonces, cada punto del nuevo jugador va completo al escuadrón.',
      ],
    },
    who: {
      title: 'Qué batallas suman puntos',
      intro: 'Mientras la CPE de un jugador esté por debajo del nivel en el que se estanca con su % de victorias (la tabla «[Hasta dónde puede subir la CPE](/guides/psr#ceiling)»), sus batallas suman de media puntos al escuadrón. Por encima, los restan, aunque el jugador juegue bien:',
      head: ['CPE del jugador', '% de victorias', 'De media cada 10 batallas'],
      notes: [
        'Los jugadores con 1300 y 1600 ganan igual de a menudo, pero el primero suma puntos al escuadrón y el segundo se los resta: con el 60% de victorias la CPE se estanca en 1570. Si dos jugadores son igual de fuertes, el escuadrón gana más alineando al de menor CPE, siempre que el cambio no reduzca las opciones de victoria del equipo.',
        'La CPE no baja sin batallas, así que un jugador por encima de su nivel conserva los puntos del escuadrón mientras no juega.',
      ],
    },
    roster: {
      title: 'Otros miembros y limpieza de la plantilla',
      body: [
        'Los miembros fuera de los 20 mejores también suman puntos, el 5% de su CPE cada uno: 100 jugadores con 1000 de CPE suman 5000, más o menos lo mismo que tres jugadores del top 20.',
        'Por eso expulsar a un miembro cuesta puntos. Un miembro fuera del top 20 con 1000 de CPE se lleva 50. Un miembro del top 20 se lleva su CPE, pero el 21.º ocupa su lugar y empieza a contar completo: el escuadrón pierde la CPE del que se va menos el 95% de la CPE del 21.º. Por ejemplo, se va un jugador con 1800 y el 21.º tiene 1500: el escuadrón pierde 1800 − 1425 = 375.',
      ],
    },
    ceiling: {
      title: 'Techo del escuadrón',
      intro: 'Cuando los 20 mejores alcanzan sus niveles, la clasificación del escuadrón deja de crecer con el número de batallas y solo crece con el % de victorias:',
      head: ['% de victorias de los 20 mejores', 'CPE de cada uno', 'Suma de los 20 mejores'],
      notes: ({ battlesLow, battlesHigh, hoursLow, hoursHigh }) => [
        `Más el 5% de la CPE del resto. Cada uno de los 20 mejores necesita ${battlesLow}–${battlesHigh} batallas para alcanzar su nivel: al [ritmo habitual](/guides/battle#length) son ${hoursLow}–${hoursHigh} horas de batallas de escuadrón. Hasta entonces, la clasificación del escuadrón también crece con el número de batallas.`,
        'Las rachas de suerte y los jugadores con CPE alta que dejaron de jugar pueden mantener a un escuadrón por encima de este nivel: sin batallas, la CPE no baja.',
      ],
    },
    live: {
      title: 'La tabla ahora mismo',
      updated: (when) => `actualizado: ${when}`,
      places: 'Lo que exige un puesto en la tabla de clasificación:',
      placesHead: ['Puesto', 'Clasificación del escuadrón'],
      groups: 'Medias de los escuadrones en estos puestos:',
      groupsHead: ['Puestos', '% de victorias', 'Batallas de la temporada', 'Jugadores'],
      conclusion: ({ times }) => `Los escuadrones en los puestos 1–10 han jugado ${times} veces más batallas que los de los puestos 51–100.`,
      note: 'Datos de la tabla de clasificación oficial de warthunder.com.',
      empty: 'La tabla de clasificación no está disponible ahora mismo.',
    },
  },
  updates: {
    lead: 'La CPE cambia justo después de la batalla, pero las páginas de warthunder.com la muestran hasta 15 minutos más tarde. Aquí: de dónde viene el retraso, cada cuánto se actualiza este sitio, las fechas de la temporada y los horarios de las batallas de escuadrón.',
    delay: {
      title: 'Cuándo aparecen los puntos',
      body: ({ min, max, median }) => [
        'El juego registra el resultado de una batalla unos 30 segundos después de que termine. Pero las páginas de escuadrón y la tabla de clasificación de warthunder.com no lo muestran enseguida: la web del juego guarda una copia durante 15 minutos y genera una nueva con la primera petición posterior.',
        `Por eso la nueva CPE aparece ${min}–${max} minutos después de la batalla, ${median} de media. Recargar más a menudo no sirve: mientras la copia no tenga más de 15 minutos, la web del juego la muestra. Si han pasado más de 15 minutos desde que terminó la batalla, recarga la página del escuadrón: mostrará el resultado.`,
        'Las batallas jugadas dentro de esos 15 minutos aparecen juntas. Se aplican una a una en el orden en que terminaron, cada una a partir de la CPE tras la anterior.',
        'La tabla de clasificación funciona igual, pero cada una de sus páginas (20 escuadrones) se actualiza por separado, aparte de las páginas de escuadrón. Por eso la tabla y la página de un escuadrón pueden mostrar durante un rato clasificaciones distintas.',
      ],
    },
    site: {
      title: 'Cómo se actualiza este sitio',
      body: [
        'Este sitio toma las clasificaciones y los puestos de los escuadrones de la tabla de clasificación de warthunder.com: el top 100 cada 20 minutos, el resto cada 12 horas. Junto con la copia de 15 minutos de warthunder.com, las clasificaciones de los líderes suelen ir aquí como mucho 35 minutos por detrás del juego.',
        'La CPE de los jugadores sale de las páginas de escuadrón: el bot lee la página de un escuadrón cuando publica una batalla con ese escuadrón y repasa una vez al día las plantillas de los 100 primeros escuadrones. Por eso la CPE de un jugador puede ir aquí por detrás del juego.',
      ],
    },
    season: {
      title: 'Temporada',
      body: ['Al inicio de cada temporada, la CPE de todos los jugadores y la clasificación de todos los escuadrones vuelven a cero. La temporada se divide en etapas, cada una con su propio BR máximo de vehículos:'],
    },
    hours: {
      title: 'Horarios de las batallas de escuadrón',
      body: ({ first, second, peak, firstShare, firstPsr, secondPsr }) => [
        `Las batallas de escuadrón se juegan cada día en dos franjas (en tu hora local): ${first} y ${second}. La primera franja reúne el ${firstShare} de todas las batallas, y las horas de más actividad son ${peak}.`,
        `En la segunda franja los rivales son algo más fuertes: la CPE media de un equipo allí suele ser ${secondPsr}, frente a ${firstPsr} en la primera.`,
      ],
    },
  },
  battle: {
    lead: ({ battles }) =>
      `Todas las batallas de escuadrón son 8 contra 8, Realista, Dominación. Aquí: cómo transcurren y qué las decide, según todas las batallas de escuadrón de la base de datos del bot (${battles}).`,
    vehicles: {
      title: 'Un vehículo por batalla',
      body: ({ aircraft, none, four }) => [
        'En una batalla de escuadrón cada jugador tiene un solo vehículo. Si se lo destruyen, queda fuera hasta el final de la batalla, y el equipo sigue sin él.',
        `El ${aircraft} de los vehículos en batalla son aviones y helicópteros; el resto, vehículos terrestres. Lo más frecuente es que un equipo no lleve ningún avión (así juega el ${none} de los equipos) o lleve cuatro (el ${four}). Más de cuatro casi nunca ocurre.`,
      ],
    },
    length: {
      title: 'Cuánto dura una batalla',
      body: ({ median, p90, over10, firstKill, gap, series, perHour }) => [
        `La mitad de las batallas terminan en menos de ${median}, y nueve de cada diez, en menos de ${p90}. Solo el ${over10} de las batallas dura más de 10 minutos. El primer vehículo suele caer ${firstKill} después del inicio.`,
        `La siguiente batalla suele empezar ${gap} después de que termine la anterior. Una serie típica son ${series} batallas seguidas, y en una hora de juego un pelotón hace de media ${perHour} batallas, pausas incluidas.`,
      ],
    },
    ending: {
      title: 'Cómo termina una batalla',
      body: ({ wiped, captured, onlyAircraft, survivors }) => [
        `En el ${wiped} de las batallas, el equipo perdedor queda destruido hasta el último vehículo.`,
        `En las demás, los perdedores aún tenían vehículos, pero perdieron por las zonas: en el ${captured} de esas batallas, los ganadores capturaron más zonas. Lo más frecuente es que a los perdedores solo les quedaran aviones (el ${onlyAircraft} de esas batallas), y los aviones no capturan zonas.`,
        `Ganar también cuesta caro: de los 8 jugadores del equipo ganador, al final suelen seguir vivos ${survivors}.`,
      ],
    },
    decides: {
      title: 'Qué decide una batalla',
      intro: 'Con qué frecuencia gana un equipo que:',
      head: ['El equipo', 'Victorias'],
      rows: {
        moreKills: 'Causa más bajas que el rival',
        firstKill: 'Causa la primera baja de la batalla',
        fewerKills: 'Causa menos bajas que el rival',
        notLoaded: 'Tiene un jugador sin cargar más',
        bot: 'Tiene un bot en lugar de un jugador sin cargar',
        psr: ({ gap }) => `Tiene una CPE media superior en ${gap} o más`,
        squadron: ({ gap }) => `Tiene una clasificación de escuadrón superior en ${gap} o más`,
      },
      notes: ({ withFirst, withoutFirst, notLoadedBattles, botWins, botBattles, aircraft, aircraftKills, spread }) => [
        `**Causar la primera baja** importa, y no solo porque suelan hacerlo los más fuertes. Incluso un escuadrón que gana la mitad de sus batallas gana el ${withFirst} cuando causa la primera baja y el ${withoutFirst} cuando no.`,
        '**Con menos bajas causadas** un equipo casi siempre pierde, y sus raras victorias suelen llegar por las zonas.',
        `**Un jugador sin cargar** es casi una derrota (hay ${notLoadedBattles} batallas así en los datos). Normalmente un bot ocupa su lugar, pero incluso con él el equipo solo gana ${botWins} batallas de ${botBattles}.`,
        `**La aviación.** Los aviones y helicópteros son el ${aircraft} de los vehículos, pero causan el ${aircraftKills} de las bajas. Aun así, la victoria apenas depende de cuántos haya: el % de victorias de un mismo escuadrón con cualquier número de aviones, de 0 a 4, no se aparta del habitual en más del ${spread}.`,
        'Más sobre hasta qué punto las clasificaciones predicen al ganador, en las [estadísticas](/guides/stats#psr).',
      ],
    },
    sides: {
      title: 'Lados del mapa',
      body: ({ team1, team2, maps, minBattles, low, high }) => [
        `El lado del mapa no da ventaja: los equipos 1 y 2 ganaron casi lo mismo (${team1} y ${team2}). En cada mapa con más de ${minBattles} batallas (${maps} mapas), el primer lado gana entre el ${low} y el ${high} de las batallas, dentro de lo que da el azar.`,
      ],
    },
  },
  stats: {
    lead: ({ battles, date }) =>
      `Batallas de escuadrón en la base de datos del bot a ${date}: ${battles}. Todas son 8 contra 8, Realista, Dominación.`,
    psr: {
      title: 'Hasta qué punto la CPE predice al ganador',
      intro: 'El equipo con más CPE media gana más a menudo, pero mucho menos de lo que promete la fórmula:',
      head: ['Diferencia de CPE media entre equipos', 'Gana el equipo con más CPE', 'Según la fórmula de la CPE', 'Batallas'],
      notes: [
        '**Según la fórmula de la CPE** — con qué frecuencia ganaría el equipo si la CPE midiera la fuerza con exactitud. La ventaja real es menor: la CPE crece con el número de batallas, no solo con la habilidad ([por qué](/guides/psr#ceiling)). El % de victorias de un jugador dice más de su fuerza.',
      ],
    },
    squadron: {
      title: 'Hasta qué punto la clasificación del escuadrón predice al ganador',
      head: ['Diferencia de clasificación de los escuadrones', 'Gana el escuadrón mejor clasificado', 'Batallas'],
      notes: ({ even, strong, strongWins }) => [
        `Con una diferencia de hasta ${even}, cada escuadrón gana más o menos igual de a menudo. Solo con una diferencia de más de ${strong} el escuadrón mejor clasificado gana el ${strongWins} de las batallas: la clasificación crece con el número de batallas, y en una batalla solo luchan 8 jugadores, no necesariamente los más fuertes.`,
      ],
    },
    matchmaking: {
      title: 'Emparejamiento de rivales',
      body: ({ psrReal, psrRandom, squadronReal, squadronRandom, repeat, opponents }) => [
        `El emparejamiento apenas tiene en cuenta las clasificaciones. La CPE media de los equipos de una batalla suele diferir en ${psrReal}, mientras que dos equipos al azar que jugaron en las mismas 2 horas difieren en ${psrRandom}. En la clasificación de los escuadrones es ${squadronReal} frente a ${squadronRandom}. Un rival con 200 de CPE más o menos es normal.`,
        `Los rivales se repiten a menudo: dentro de una misma [franja de batallas de escuadrón](/guides/updates#hours), el ${repeat} de las batallas de un escuadrón son contra un escuadrón con el que ya jugó en esa franja. En 10 batallas seguidas se enfrenta de media a ${opponents} rivales distintos.`,
      ],
    },
    distribution: {
      title: 'Cuántos jugadores alcanzan una CPE alta',
      intro: ({ players, zero }) =>
        `Jugadores de escuadrón cuya CPE vio el bot esta temporada: ${players}. De ellos, el ${zero} tiene 0 de CPE, es decir, aún no ha ganado esta temporada. Entre el resto:`,
      head: ['CPE', 'Proporción de jugadores'],
      notes: ({ median, top10, top1, max }) => [
        `La mitad está por debajo de ${median}. El 10% mejor empieza en ${top10}; el 1% mejor, en ${top1}. La CPE más alta que ha visto el bot es ${max}.`,
      ],
    },
    activity: {
      title: 'Cuánto se juega',
      intro: ({ from, to }) => `Un día normal de esta temporada (medias de los días completos del ${from} al ${to}):`,
      head: ['Por día', 'De media'],
      rows: {
        battles: 'Batallas de escuadrón',
        squadrons: 'Escuadrones en batallas',
        players: 'Jugadores en batallas',
        squadronDay: 'Batallas de un escuadrón',
        playerDay: 'Batallas de un jugador',
      },
      notes: ({ low, high, topLow, topHigh, from, to, playersLow, playersHigh }) => [
        `Batallas por día: de ${low} a ${high}. Un escuadrón o un jugador solo cuenta los días en que jugó.`,
        `Los 10 escuadrones más activos juegan de ${topLow} a ${topHigh} batallas al día y, del ${from} al ${to}, alinearon cada uno de ${playersLow} a ${playersHigh} jugadores distintos. De ellos, solo los 20 mejores cuentan completos en la clasificación del escuadrón ([por qué](/guides/squadron#top20)).`,
      ],
    },
  },
  method: {
    lead: 'Gaijin no publica la fórmula de la CPE. Las reglas de estas guías se reconstruyeron a partir de datos públicos de warthunder.com y se comprobaron en batallas reales. No son datos oficiales: Gaijin puede cambiar las reglas en cualquier momento, y entonces las cifras de aquí quedarán desfasadas.',
    data: {
      title: 'Datos',
      body: ({ date, battles, changes, psrBattles, squadronBattles, from1, to1, from2, to2 }) => [
        `El bot recoge la CPE de los miembros de los escuadrones y la tabla de clasificación de escuadrones de las páginas de warthunder.com, y de las repeticiones de las batallas, quién jugó, con qué vehículo, quién destruyó a quién, quién capturó zonas y quién ganó. A ${date}, la base de datos contiene ${battles} batallas de escuadrón y ${changes} cambios de CPE. Las batallas van del ${from1} al ${to1} y del ${from2} al ${to2}: los demás días el bot no las recogió.`,
        `Las comparaciones de CPE entre equipos usan las batallas en las que se conoce la CPE de al menos 6 de los 8 jugadores de cada equipo (${psrBattles}); las de escuadrones, las batallas en las que se conocen las clasificaciones de ambos escuadrones (${squadronBattles}).`,
      ],
    },
    formula: {
      title: 'Fórmula de la CPE',
      body: ({ single, k, reference, scale, withinOne, chainLow, chainHigh, liveMatched, liveTotal, max, strong, fixed, enemy, weaker }) => [
        `La fórmula se ajustó con los casos en que entre dos lecturas de la CPE de un jugador hubo exactamente una batalla (${single}). El sistema Elo fue el que mejor encajó. Los valores obtenidos (${k}; ${reference}; ${scale}) corresponden a 32, 1500 y 400.`,
        `Para una sola batalla, la fórmula coincide con la web del juego con un margen de 1 punto en el ${withinOne} de los casos. Explica entre el ${chainLow} y el ${chainHigh} de los cambios que abarcan varias batallas, según la CPE. En una comprobación en directo coincidieron ${liveMatched} de ${liveTotal} cambios.`,
        `Una comprobación más amplia en octubre de 2026 mostró que un rival fuerte sí cuenta. En ${strong} cambios de una sola batalla contra un equipo con una CPE media de más de 1500, un rival fijo de 1500 coincidió con la web del juego con un margen de 1 punto solo en el ${fixed} de los casos, y la CPE media del equipo rival en el ${enemy}. Contra equipos más débiles ambos dan el ${weaker}: el rival nunca cuenta como más débil que 1500.`,
        `Comprobada con CPE de 0 a ${max}, la más alta de los datos; por encima no hay con qué comprobar la fórmula.`,
      ],
    },
    squadron: {
      title: 'Clasificación del escuadrón',
      body: ({ states, errorLow, errorHigh }) => [
        `La fórmula de la clasificación del escuadrón se comprobó en ${states} estados de páginas de escuadrón: la diferencia fue de ${errorLow} a ${errorHigh} puntos, los decimales de la CPE que la web del juego no muestra.`,
      ],
    },
    timing: {
      title: 'Momento de la actualización',
      body: ({ date, from, to, poll, squadrons, battles, min, max, median, fresh, timer }) => [
        `El ${date}, de ${from} a ${to} UTC, el bot leyó las páginas de ${squadrons} escuadrones cada ${poll} segundos durante sus batallas. En ${battles} batallas, el resultado apareció ${min}–${max} minutos después del final de la batalla, ${median} de media.`,
        `Las actualizaciones de las páginas llegaban exactamente cada 15 minutos, y la primera petición tras una pausa obtuvo datos nuevos en el ${fresh} de los casos; una página actualizada a intervalos fijos daría alrededor del ${timer}. Así que la página se regenera bajo petición en cuanto su copia tiene más de 15 minutos.`,
      ],
    },
    code: {
      title: 'Código',
      body: ({ url }) => [`La fórmula y todas las tablas de estas guías se calculan en el código abierto del sitio: [lib/psr.ts](${url}).`],
    },
  },
}
