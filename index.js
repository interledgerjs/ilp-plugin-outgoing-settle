const PluginMiniAccounts = require('ilp-plugin-mini-accounts')
const StoreWrapper = require('./store-wrapper') // TODO: module-ize this
const DEFAULT_SETTLE_THRESHOLD = 25 * Math.pow(10, 6) // 25 XRP

class PluginOutgoingSettle {
  constructor (opts) {
    super(opts)

    this._secret = opts.secret
    this._address = opts.address
    this._xrpServer = opts.xrpServer

    this._settleThreshold = opts.settleThreshold || DEFAULT_SETTLE_THRESHOLD
    this._store = new StoreWrapper(opts._store)
  }
}

PluginOutgoingSettle.version = 2
module.exports = PluginOutgoingSettle
