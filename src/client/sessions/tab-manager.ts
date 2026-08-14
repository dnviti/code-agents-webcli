// Session tab management: create, switch, reorder, and close tabs
//
// The strip is rendered by the Relay `TabBar` from `shellStore`. This class no
// longer builds or reads any DOM: `tabs` used to be `Map<string, HTMLElement>`
// and several methods read state back out of those nodes (a tab's name came
// from its `.tab-name` textContent, unread came from a CSS class). It is a
// plain record now, and `syncShell()` is the only way any of it reaches the
// screen.

export { SessionTabManager } from './tab-manager/session-tab-manager';
export type { ListedSession } from './tab-manager/types';