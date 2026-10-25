const major = Number(process.versions.node.split('.')[0]);
if (major !== 24) {
  console.error(`CentrAlign Operator requires Node 24.x. Current runtime: ${process.version}. Select Node 24 and retry.`);
  process.exitCode = 1;
}
