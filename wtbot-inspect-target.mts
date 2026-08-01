import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync('D:/GITproject/untitled1/wtbot/data/wtbot.db', { readOnly: true })
const id = '505118034098855889'
const hex = '07028a2d001b1fd1'
console.log(db.prepare('PRAGMA table_info(battles)').all())
console.log(db.prepare('SELECT session_id, session_hex FROM battles WHERE session_id = ? OR session_hex = ?').all(id, hex))
console.log(db.prepare('SELECT session_id, session_hex, name, team, clan_tag, vehicles_json FROM battle_players WHERE session_id = ? OR session_id = ?').all(id, hex))
db.close()
