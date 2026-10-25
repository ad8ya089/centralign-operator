export function assertSupportedRuntime(version = process.versions.node): void {
  if (Number(version.split('.')[0]) !== 24) throw new Error('CentrAlign requires Node 24.x before opening native SQLite (Node-API 10).');
}
