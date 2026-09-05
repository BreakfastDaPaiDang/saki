/** Install Proxy tracking before bundled dependencies or VFS modules construct proxies. */
import { installProxyGlobal } from './proxy.ts'

installProxyGlobal()
