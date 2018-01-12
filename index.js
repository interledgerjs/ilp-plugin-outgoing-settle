const { RippleAPI } = require('ripple-lib')
const PluginMiniAccounts = require('ilp-plugin-mini-accounts')
const Account = require('./src/account')
const StoreWrapper = require('./src/store-wrapper') // TODO: module-ize this
const DEFAULT_SETTLE_THRESHOLD = 25 * Math.pow(10, 6) // 25 XRP
const { util } = require('ilp-plugin-xrp-paychan-shared')

class PluginOutgoingSettle {
  constructor (opts) {
    super(opts)

    this._secret = opts.secret
    this._address = opts.address // TODO: default to derived from secret
    this._xrpServer = opts.xrpServer
    this._api = new RippleAPI({ server: this._xrpServer })

    this._settleThreshold = opts.settleThreshold || DEFAULT_SETTLE_THRESHOLD
    this._store = new StoreWrapper(opts._store)
    this._accounts = new Map()

    this._submitted = {}
  }

  _getAccount (from) {
    const accountName = this.ilpAddressToAccount(this._prefix, from)
    let account = this._accounts.get(accountName)

    if (!account) {
      account = new Account({ 
        account: accountName,
        store: this._store,
      })
      this._accounts.set(accountName, account)
    }

    return account
  }

  async _preConnect () {
    await this._api.connect()
    await this._api.connection.request({
      command: 'subscribe',
      accounts: [ this._address ]
    })
    this._api.connection.on('transaction', this._handleTransaction.bind(this))
  }

  async _connect (from, authPacket) {
    const account = this._getAccount(from)
    await account.connect()

    // TODO: get an XRP address from the auth packet
  }

  async _disconnect () {
    // TODO?
  }

  async _sendPrepare (destination, prepare) {
    // TODO?
  }

  async _handlePrepareResponse (destination, response, prepare) {
    if (response.type === IlpPacket.Type.TYPE_ILP_FULFILL) {
      const fulfillment = response.data.fulfillment
      const condition = prepare.data.executionCondition
      const hashedFulfillment = crypto
        .createHash('sha256')
        .update(fulfillment)
        .digest()

      if (!hashedFulfillment.equals(condition)) {
        throw new Error(`invalid fulfillment.
          condition=${condition.toString('base64')}
          fulfillment=${fulfillment.toString('base64')}
          hashedFulfillment=${hashedFulfillment.toString('base64')}`)
      }

      // TODO: is it possible that this account is unloaded?
      const account = this._getAccount(destination)
      const oldBalance = account.getBalance()
      const balance = oldBalance.add(prepare.data.amount)
      account.setBalance(balance.toString())

      if (balance.greaterThan(this._settleThreshold)) {
        account.setBalance('0')
        // don't await, because we don't want the fulfill call to take a long
        // time and potentially drop the fulfillment while passing back.
        this._settle(account, balance)
      }
    }
  }

  async _handleCustomData (from, btpPacket) {
    // Bounce everything to prevent sending from client
    // TODO: should anything ever be let through?
    throw new Error(`your account is receive only. please connect to a
      different system to send. from=${from} packet=${btpPacket}`)
  }

  async _settle (account, balance) {
    debug('sending settlement. account=', account.getAccount(),
      'balance=', balance.toString())

    const value = util.dropsToXrp(balance.toString())
    const tx = await this._api.preparePayment(account.getXrpAddress(), {
      source: {
        address: this._address,
        maxAmount: {
          value,
          currency: 'XRP'
        }
      },
      destination: {
        address: account.getXrpAddress(),
        amount: {
          value,
          currency: 'XRP'
        }
      }
    })

    debug('signing settlement tx. account=', account.getAccount())
    const signed = await this._api.sign(tx.txJSON, this._secret)
    const txHash = signed.id
    const result = new Promise((resolve, reject) => {
      this._submitted[txHash] = { resolve, reject }
    })
     
    debug('submitting settlement tx. account=', account.getAccount())
    await this._api.submit(signed.signedTransaction)

    return result
  }

  // from https://github.com/ripple/ilp-plugin-xrp-escrow/blob/master/src/plugin.js#L414
  _handleTransaction (ev) {
    if (ev.validated && ev.transaction && this._submitted[ev.transaction.hash]) {
      // give detailed error on failure
      if (ev.engine_result !== 'tesSUCCESS') {
        this._submitted[ev.transaction.hash].reject(new Errors.NotAcceptedError('transaction with hash "' +
          ev.transaction.hash + '" failed with engine result: ' +
          JSON.stringify(ev)))
      } else {
        // no info returned on success
        this._submitted[ev.transaction.hash].resolve(null)
      }
    }
  }
}

PluginOutgoingSettle.version = 2
module.exports = PluginOutgoingSettle
