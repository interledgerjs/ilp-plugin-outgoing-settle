const PluginOutgoingSettle = require('.')
const PluginBtp = require('ilp-plugin-btp')
const crypto = require('crypto')
const IlpPacket = require('ilp-packet')

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

  const fulfillment = crypto.randomBytes(32)
  const condition = crypto
    .createHash('sha256')
    .update(fulfillment)
    .digest()

  client.registerDataHandler(data => {
    return IlpPacket.serializeIlpFulfill({
      fulfillment,
      data: Buffer.alloc(0)
    })
  })

  for (let i = 0; i < 6; ++i) {
    console.log('sending 5 xrp')
    await server.sendData(IlpPacket.serializeIlpPrepare({
      amount: String(5 * Math.pow(10, 6)),
      destination: 'test.settle.K7gNU3sdo-OL0wNhqoVWhr3g6s1xYv72ol_pe_Unols',
      executionCondition: condition,
      expiresAt: new Date(Date.now() + 10000),
      data: Buffer.alloc(0)
    }))

    await new Promise(resolve => setTimeout(resolve, 500))
  }

  console.log('settling')
  await new Promise(resolve => setTimeout(resolve, 5000))
  console.log('done')
}

run()
  .then(() => {
    process.exit(0)
  })
  .catch(e => {
    console.log(e)
    process.exit(1)
  })
