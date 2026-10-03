import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config.js'
import { closeDb, getUnanalyzedItems, initDb, saveAnalysis } from '../db/index.js'

// AI analysis of collected items (Claude), run by hand (paid API calls):
//   npm run analyze          — analyze 3 items
//   npm run analyze -- 20    — analyze 20 items
//
// Analysis runs apart from the parsers and the site: each item is analyzed
// once (analyses.item_id is unique), the result is stored in the database and
// shows on the dashboard and in the API. Parsers and ingest never call it.
//
// Needs ANTHROPIC_API_KEY in .env (https://platform.claude.com/ → API Keys).

const MODEL = 'claude-opus-5-5'

const argLimit = Number(process.argv[2])
const limit = Number.isFinite(argLimit) && argLimit > 0 ? argLimit : 3

initDb(config.dbPath, { allowCreate: config.allowNewDb })

const items = getUnanalyzedItems(limit)
if (items.length === 0) {
  console.log('Every collected item is already analyzed: the queue is empty.')
  closeDb()
  process.exit(0)
}

console.log(`To analyze: ${items.length} items (model ${MODEL})`)

let client: Anthropic
try {
  client = new Anthropic() // reads ANTHROPIC_API_KEY
} catch {
  console.error('No API key: add ANTHROPIC_API_KEY=sk-ant-... to .env')
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
        'You analyze data a bot collected from websites. ' +
        'Answer in English, in one or two sentences, without a preamble.',
      messages: [
        {
          role: 'user',
          content:
            `An item from the source "${item.source}". What is it about and why could it be interesting?\n\n` +
            `Title: ${item.title}\nData: ${JSON.stringify(item.data)}`,
        },
      ],
    })

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join(' ')
      .trim()

    saveAnalysis(item.id, text || '(empty answer)', MODEL)
    console.log(`✓ [${item.source}] ${item.title.slice(0, 50)}… → ${text.slice(0, 80)}`)
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      console.error('The API key was rejected: check ANTHROPIC_API_KEY in .env')
      break
    }
    // A missing key is a plain Error thrown before the request (the SDK has no
    // class for it), so it is recognized by its text.
    if (err instanceof Error && err.message.includes('Could not resolve authentication')) {
      console.error('No API key: add ANTHROPIC_API_KEY=sk-ant-... to .env')
      break
    }
    console.error(`✗ [${item.source}] ${item.title.slice(0, 50)}…:`, err)
  }
}

closeDb()
