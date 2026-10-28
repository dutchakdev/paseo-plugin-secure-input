/**
 * The user the plugin runs as. The plugin runs on macOS and Linux only (`os` in package.json), where there is one; what
 * a directory or a file has to be owned by is decided where each is checked (a private directory, `holdDirectory`): only
 * the number is shared.
 */
export function uid(): number {
  return (process.getuid as () => number)();
}
