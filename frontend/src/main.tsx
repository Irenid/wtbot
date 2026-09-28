import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from './App'
import { I18nProvider } from './i18n'
// Заголовочный шрифт раздаётся самим сайтом: запрос к Google Fonts раскрывал
// бы IP каждого посетителя и ломал вёрстку в сетях без доступа к Google.
import '@fontsource/space-grotesk/500.css'
import '@fontsource/space-grotesk/600.css'
import '@fontsource/space-grotesk/700.css'
import './theme.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <BrowserRouter basename="/app">
        <App />
      </BrowserRouter>
    </I18nProvider>
  </StrictMode>,
)
