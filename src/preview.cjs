const path = require('node:path');
const { Studio } = require('./core.cjs');
const { startServer } = require('./server.cjs');
const { seed } = require('./seed.cjs');
(async () => {
  const studio = new Studio(process.env.STUDIO_DATA || path.join(__dirname, '../data-preview')); seed(studio);
  const { server, url } = await startServer(studio, { port: Number(process.env.PORT || 43128), preview: true });
  console.log(`画布预览：${url}（独立预览数据，不接入真实账号）`);
  process.on('SIGINT', () => server.close(() => process.exit(0)));
})().catch(e => { console.error(e.message); process.exit(1); });
