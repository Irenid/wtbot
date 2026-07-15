import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config.js'
import { closeDb, getUnanalyzedItems, initDb, saveAnalysis } from '../db/index.js'

// Анализ собранных записей нейросетью (Claude). Запуск вручную:
//   npm run analyze          — проанализировать 3 записи
//   npm run analyze -- 20    — проанализировать 20 записей
//
// Ключевая идея конвейера: анализ работает ОТДЕЛЬНО от парсеров и сайта,
// каждая запись анализируется один раз, результат кэшируется в БД (analyses)
// и мгновенно виден на дашборде и в API. Когда захочешь автоматизировать —
// вызывай analyzeBatch() по интервалу из src/index.ts, как парсеры.
//
// Нужен ключ API: https://platform.claude.com/ → API Keys →
// добавь в .env строку ANTHROPIC_API_KEY=sk-ant-...

const MODEL = 'claude-opus-4-8'

const argLimit = Number(process.argv[2])
const limit = Number.isFinite(argLimit) && argLimit > 0 ? argLimit : 3

initDb(config.dbPath)

const items = getUnanalyzedItems(limit)
if (items.length === 0) {
  console.log('Все собранные записи уже проанализированы — очередь пуста.')
  closeDb()
  process.exit(0)
}

console.log(`К анализу: ${items.length} записей (модель ${MODEL})`)

let client: Anthropic
try {
  client = new Anthropic() // ключ берётся из ANTHROPIC_API_KEY автоматически
} catch {
  console.error('Не найден ключ API. Добавь в .env строку: ANTHROPIC_API_KEY=sk-ant-...')
  closeDb()
  process.exit(1)
}

for (const item of items) {
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      thinking: { type: 'adaptive' },
      system:
        'Ты — аналитик данных, собранных ботом с разных сайтов. ' +
        'Отвечай по-русски, одним-двумя предложениями, без преамбулы.',
      messages: [
        {
          role: 'user',
          content:
            `Запись из источника «${item.source}». О чём она и чем может быть интересна?\n\n` +
            `Заголовок: ${item.title}\nДанные: ${JSON.stringify(item.data)}`,
        },
      ],
    })

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join(' ')
      .trim()

    saveAnalysis(item.id, text || '(пустой ответ)', MODEL)
    console.log(`✓ [${item.source}] ${item.title.slice(0, 50)}… → ${text.slice(0, 80)}`)
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      console.error('Ключ API не подошёл. Проверь ANTHROPIC_API_KEY в .env')
      break
    }
    // Ключ не найден: SDK бросает обычный Error ещё до запроса,
    // типизированного класса у этой ошибки нет — распознаём по тексту
    if (err instanceof Error && err.message.includes('Could not resolve authentication')) {
      console.error('Не найден ключ API. Добавь в .env строку: ANTHROPIC_API_KEY=sk-ant-...')
      break
    }
    console.error(`✗ [${item.source}] ${item.title.slice(0, 50)}…:`, err)
  }
}

closeDb()
