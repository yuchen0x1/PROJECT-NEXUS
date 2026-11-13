const fs = require('node:fs/promises')
const path = require('node:path')

module.exports = async ({ appOutDir }) => {
  // This is Electron's sample launcher, not the application archive.
  const target = path.join(path.resolve(appOutDir), 'resources', 'default_app.asar')
  await fs.rm(target, { force: true })
}
