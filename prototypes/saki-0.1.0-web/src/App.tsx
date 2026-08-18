import { useStore } from './client/store'
import { navStore } from './client/navigation'
import { AppFrame } from './shell/AppFrame'
import { DevBar, ReceiptToasts } from './shell/DevBar'
import { MyWorkPage } from './pages/work/MyWorkPage'
import { ProjectsPage } from './pages/projects/ProjectsPage'
import { ProjectPage } from './pages/project/ProjectPage'
import { BootstrapPage } from './pages/bootstrap/BootstrapPage'
import { ConversationPage } from './pages/conversation/ConversationPage'
import { NewSessionPage } from './pages/conversation/NewSessionPage'
import { SettingsDialog } from './pages/settings/SettingsDialog'

/**
 * The prototype's main-surface dispatch: exactly two new Saki top-level pages
 * (工作 / 项目) plus inherited DSH pages (Conversation, New Session, Settings).
 * Settings remains a dialog over the current surface, as in the shipped UI.
 */
export function App() {
  const { address } = useStore(navStore)

  return (
    <AppFrame>
      <MainSurface />
      {address.kind === 'settings' ? <SettingsDialog section={address.section} /> : null}
      <DevBar />
      <ReceiptToasts />
    </AppFrame>
  )
}

function MainSurface() {
  const { address } = useStore(navStore)
  switch (address.kind) {
    case 'bootstrap':
      return <BootstrapPage />
    case 'my-work':
      return <MyWorkPage />
    case 'projects':
      return <ProjectsPage />
    case 'work':
    case 'milestones':
    case 'changes':
    case 'sessions':
    case 'trace':
    case 'project-settings':
      return <ProjectPage address={address} />
    case 'conversation':
      return <ConversationPage sessionId={address.sessionId} />
    case 'new-session':
      return <NewSessionPage />
    case 'settings':
      // The dialog renders over whatever was underneath; My Work is the
      // neutral backdrop when the dialog is opened directly via URL.
      return <MyWorkPage />
  }
}
