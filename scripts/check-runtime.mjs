const major = Number(process.versions.node.split('.')[0]);
if (major !== 24) {
  throw new Error(`CentrAlign Operator requires Node 24.x. Current runtime: ${process.version}. Select Node 24 for node and npm, then retry. Native SQLite requires Node-API 10.`);
}
