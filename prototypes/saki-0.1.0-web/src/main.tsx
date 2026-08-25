import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ControlPlaneProvider } from './client/controlPlane'
import { navigate } from './client/navigation'
import { getScenario } from './fixtures/scenarios'
import { App } from './App'
import './styles/tokens.css'
import './styles/base.css'

function Root() {
  const [scenarioId, setScenarioId] = useState<string | null>(new URLSearchParams(window.location.search).get('scenario'))

  // Deep link wins; an explicit ?scenario without a hash opens the scenario's
  // documented start address; otherwise the persisted address restores.
  useEffect(() => {
    if (!window.location.hash && scenarioId) {
      navigate(getScenario(scenarioId).startAddress, { replace: true })
    }
  }, [])

  return (
    <StrictMode>
      <ControlPlaneProvider scenarioId={scenarioId} onScenarioChange={setScenarioId}>
        <App />
      </ControlPlaneProvider>
    </StrictMode>
  )
}

createRoot(document.getElementById('root')!).render(<Root />)
