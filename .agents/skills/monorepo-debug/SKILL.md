---
name: monorepo-debug
description: Diagnose and minimally fix bugs in a large monorepo. Use when the user reports that a command, the bot, a function, an endpoint, a handler or another feature does not work, crashes or misbehaves.
---

# Bug diagnosis

Work step by step; change code only from step 4 on.

1. **Explore.** Check the Git state. Find the failure's entry point, related
   files, callers and callees, handlers, routes, worker tasks and tests with
   targeted search (`rg`, `git grep`); a code-index MCP only if the
   environment has one. Do not read the whole repository.
2. **Cause.** Read the implementations you found and compare expected and
   actual behavior: configuration, handler registration, middleware order,
   conditions, exceptions, tests. Name the cause and the evidence; until it is
   confirmed, keep diagnosing.
3. **Plan.** Before editing, list the affected modules, files, functions,
   tests and possible side effects.
4. **Fix.** A minimal change without unrelated refactoring or needless public
   interface changes; a minimal regression test.
5. **Check.** Related tests first, `npm run verify` before handing off
   (AGENTS.md, sections 10 and 12); `git diff`; impact on callers, routes and
   worker tasks — search by the changed function's name. RTK — if the
   environment has it.
6. **Report.** Cause, changed files, the fix, tests run and their results,
   remaining risks.
