async function main() {
  if (!process.env.BLOCKS_STACK_NAME) {
    throw new Error(
      'BLOCKS_STACK_NAME must be set to the deployed stack name (e.g. cloud-97e092-e2e) — ' +
        'required so DistributedTable resolves the correct physical table name.',
    );
  }
  const { readings } = await import('../aws-blocks/index.js');

  const items = [];
  for await (const item of readings.scan()) {
    items.push(item);
  }
  if (items.length === 0) {
    console.log('e2e table already empty');
    return;
  }
  await readings.deleteBatch(items.map((i) => ({ deviceId: i.deviceId, timestamp: i.timestamp })));
  console.log(`cleared ${items.length} item(s) from the e2e table`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
