const { RippleAPI } = require('ripple-lib')
const IlpPacket = require('ilp-packet')
const crypto = require('crypto')
const debug = require('debug')('ilp-plugin-outgoing-settle')
const PluginMiniAccounts = require('ilp-plugin-mini-accounts')
const Account = require('./src/account')
const StoreWrapper = require('./src/store-wrapper') // TODO: module-ize this
const DEFAULT_SETTLE_THRESHOLD = 25 * Math.pow(10, 6) // 25 XRP
const addressCodec = require('ripple-address-codec')
const dropsToXrp = d => d.div(Math.pow(10, 6)).toString()

class PluginOutgoingSettle extends PluginMiniAccounts {
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
    const accountName = this.ilpAddressToAccount(from)
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

  async _connect (from, authPacket, { ws, req }) {
    const account = this._getAccount(from)
    await account.connect()

    // Once an XRP address is associated with an account, it must not change.
    // This is to prevent anyone from stealing funds if an account is
    // compromised.

    const addressInPath = req.url.substring(1)
    const existingAddress = account.getXrpAddress()

    if (!addressCodec.isValidAddress(addressInPath)) {
      throw new Error('invalid XRP address in path. path="' + req.url + '"')
    } else if (existingAddress && existingAddress !== addressInPath) {
      throw new Error(`XRP address is path does not match stored address. path="${req.url}" stored="${existingAddress}"`)
    } else {
      debug('setting xrp address. address=' + addressInPath)
      account.setXrpAddress(addressInPath)
    }

    debug('got xrp address. address=' + account.getXrpAddress(),
      'account=' + account.getAccount())
  }

  // These handlers are not currently needed
  // async _disconnect () { }
  // async _sendPrepare (destination, prepare) { }

  async _handlePrepareResponse (destination, response, prepare) {
    if (response.type === IlpPacket.Type.TYPE_ILP_FULFILL) {
      const fulfillment = response.data.fulfillment
      const condition = prepare.data.executionCondition
      const hashedFulfillment = crypto
        .createHash('sha256')
        .update(fulfillment)
        .digest()

      if (!hashedFulfillment.equals(condition)) {
        throw new Error(`invalid fulfillment. condition=${condition.toString('base64')} fulfillment=${fulfillment.toString('base64')} hashedFulfillment=${hashedFulfillment.toString('base64')}`)
      }

      // TODO: is it possible that this account is unloaded?
      const account = this._getAccount(destination)
      const oldBalance = account.getBalance()
      const balance = oldBalance.add(prepare.data.amount)
      account.setBalance(balance.toString())

      debug(`updated balance. old=${oldBalance.toString()} new=${balance.toString()} account=${account.getAccount()}`)

      if (balance.greaterThan(this._settleThreshold)) {
        // careful that this balance operation persists, because otherwise it
        // could trigger a double-settlement which is potentially dangerous
        account.setBalance('0')
        // don't await, because we don't want the fulfill call to take a long
        // time and potentially drop the fulfillment while passing back.
        this._settle(account, balance)
      }
    }
  }

  async _handleCustomData (from, btpPacket) {
    // Bounce everything to prevent sending from client. The mini-accounts
    // class will do the job of handling ILDCP first.
    // TODO: should anything ever be let through?
    throw new Error(`your account is receive only. please connect to a different system to send. from=${from} packet=${btpPacket}`)
  }

  async _settle (account, balance) {
    debug('sending settlement. account=', account.getAccount(),
      'balance=', balance.toString())

    const value = dropsToXrp(balance)
    const tx = await this._api.preparePayment(this._address, {
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

    await result
    debug('successfully settled . account=', account.getAccount(),
      'balance=', balance.toString())
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
