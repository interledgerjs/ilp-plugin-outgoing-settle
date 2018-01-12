const PluginOutgoingSettle = require('.')
const PluginBtp = require('ilp-plugin-btp')

class Store {
  constructor () { this._s = {} }
  put (k, v) { this._s[k] = v }
  get (k) { return this._s[k] }
  del (k) { delete this._s[k] }
}

const server = new PluginOutgoingSettle({
  port: 8088,
  xrpServer: 'wss://s.altnet.rippletest.net:51233',
  secret: 'shmKxWVcvBDJwgCdxJUd2gb4tpwVc',
  address: 'rHQfnr3rS7EC7P9YdYm7zcMXtk9u48TCyB',
  _store: new Store(),
  debugHostIldcpInfo: {
    clientAddress: 'test.settle'
  }
})

const client = new PluginBtp({
  server: 'btp+ws://:secret@localhost:8088/ry1b46gwycLccXWu42kqHmM36LWMMsYu8'
})

async function run () {
  await server.connect()
  await client.connect()
  console.log('connected')
}

run()
  .then(() => {
    process.exit(0)
  })
  .catch(e => {
    console.log(e)
    process.exit(1)
  })
