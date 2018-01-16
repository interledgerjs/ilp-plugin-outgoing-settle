const { RippleAPI } = require('ripple-lib')
const IlpPacket = require('ilp-packet')
const crypto = require('crypto')
const debug = require('debug')('ilp-plugin-outgoing-settle')
const PluginMiniAccounts = require('ilp-plugin-mini-accounts')
const Account = require('./src/account')
const StoreWrapper = require('./src/store-wrapper') // TODO: module-ize this
const ReversePlugin = require('./src/reverse-plugin')
const DEFAULT_SETTLE_THRESHOLD = 1000
const FUNDING_AMOUNT = 25 * Math.pow(10, 6)
const addressCodec = require('ripple-address-codec')
const dropsToXrp = d => d.div(Math.pow(10, 6)).toString()

const Koa = require('koa')
const Router = require('koa-router')
const PSK2 = require('ilp-protocol-psk2')

class PluginOutgoingSettle extends PluginMiniAccounts {
  constructor (opts) {
    super(opts)

    this._secret = opts.secret
    this._address = opts.address // TODO: default to derived from secret
    this._xrpServer = opts.xrpServer
    this._api = new RippleAPI({ server: this._xrpServer })

    this._settleThreshold = opts.settleThreshold || DEFAULT_SETTLE_THRESHOLD
    this._settleDelay = 60 * 1000
    this._store = new StoreWrapper(opts._store)
    this._accounts = new Map()

    this._submitted = {}
    this._pendingSettlements = new Map()

    this._spspPlugin = new ReversePlugin(this)
    this._spspServer = new Koa()
    this._spspRouter = Router()
    this._spspPort = opts.spspPort || 80
  }

  _getAccount (from) {
    const accountName = this.ilpAddressToAccount(from)
    let account = this._accounts.get(accountName)

    if (!account) {
      account = new Account({ 
        account: accountName,
        store: this._store,
        api: this._api
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

    await this._spspPlugin.connect()
    this._spspReceiver = await PSK2.createReceiver({
      plugin: this._spspPlugin,
      paymentHandler: params => params.accept()
    })
    this._spspRouter.get('/', async ctx => {
      const details = this._spspReceiver.generateAddressAndSecret()
      ctx.body = {
        destination_account: details.destinationAccount,
        shared_secret: details.sharedSecret.toString('base64'),
        ledger_info: {
          asset_code: 'XRP',  
          asset_scale: 6
        },
        receiver_info: {
          name: 'Siren Automatic XRP Receiver'
        }
      }
    })
    this._spspServer
      .use(this._spspRouter.routes())
      .use(this._spspRouter.allowedRoutes())
      .listen(this._spspPort)
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
      await account.setXrpAddress(addressInPath)
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

      let account
      if (destination.startsWith(this._prefix + 'spsp.')) {
        const address = destination
          .substring((this._prefix + 'spsp.').length)
          .split('.')[0]

        if (addressCodec.isValidAddress(address)) {
          throw new Error('invalid destination. destination=' + destination +
            ' parsed_address=' + address)
        }

        account = new Account({
          address,
          store: this._store
        })

        await account.connect()
      } else {
        account = this._getAccount(destination)
      }

      // TODO: is it possible that this account is unloaded?
      const oldBalance = account.getBalance()
      const balance = oldBalance.add(prepare.data.amount)
      account.setBalance(balance.toString())

      debug(`updated balance. old=${oldBalance.toString()} new=${balance.toString()} account=${account.getAccount()}`)

      const threshold = account.addressExists()
        ? this._settleThreshold
        : BigNumber.min(this._settleThreshold, FUNDING_AMOUNT)

      if (balance.greaterThan(threshold)) {
        // careful that this balance operation persists, because otherwise it
        // could trigger a double-settlement which is potentially dangerous
        account.setBalance('0')
        const pending = this._pendingSettlements.get(account.getXrpAddress())
        const settleAmount = pending
          ? balance.add(pending.settleAmount)
          : balance

        // clear the settlement timer
        if (pending) {
          clearTimeout(pending)
          this._pendingSettlements.delete(account.getXrpAddress())
        }

        const settleCallback = () => this._settle(account, settleAmount)
          .catch(e => debug('error during settlemnt.',
            'account=' + account.getAccount(),
            'error=', e))

        // don't await, because we don't want the fulfill call to take a long
        // time and potentially drop the fulfillment while passing back.
        if (settleAmount.gt(FUNDING_AMOUNT)) {
          settleCallback() 
        } else {
          // delay on small amounts so we don't repeat settlements
          this._pendingSettlements.set(account.getXrpAddress(), {
            settleAmount: balance,
            timeout: setTimeout(settleCallback, this._settleDelay)
          })
        }
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

  async _handleOutgoingBtpPacket (to, btpPacket) {
    if (!to.startsWith(this._prefix)) {
      throw new Error(`invalid destination, must start with prefix. destination=${to} prefix=${this._prefix}`)
    }

    if (to.startsWith(this._prefix + 'spsp.')) {
      return this._spspPlugin._handleOutgoingBtpPacket(to, btpPacket)
    }

    const account = this.ilpAddressToAccount(to)
    const connections = this._connections.get(account)

    if (!connections) {
      throw new Error('No clients connected for account ' + account)
    }

    const results = Array.from(connections).map(wsIncoming => {
      const result = new Promise(resolve => wsIncoming.send(BtpPacket.serialize(btpPacket), resolve))

      result.catch(err => {
        const errorInfo = (typeof err === 'object' && err.stack) ? err.stack : String(err)
        debug('unable to send btp message to client: ' + errorInfo, 'btp packet:', JSON.stringify(btpPacket))
      })
    })

    return null
  }
}

PluginOutgoingSettle.version = 2
module.exports = PluginOutgoingSettle
