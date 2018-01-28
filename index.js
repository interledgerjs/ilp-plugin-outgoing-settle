const { RippleAPI } = require('ripple-lib')
const BigNumber = require('bignumber.js')
const BtpPacket = require('btp-packet')
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
const base32 = require('base32')
const dropsToXrp = d => d.div(Math.pow(10, 6)).toString()

const Koa = require('koa')
const Router = require('koa-router')
const PSK2 = require('ilp-protocol-psk2')

function validateDestinationTag (_tag) {
  const tag = Number(_tag)
  if (tag && (isNaN(tag) || tag > 4294967295 || tag < 0)) {
    throw new Error('invalid destination tag')
  }
}

class PluginOutgoingSettle extends PluginMiniAccounts {
  constructor (opts) {
    super(opts)

    this._secret = opts.secret
    this._address = opts.address // TODO: default to derived from secret
    this._xrpServer = opts.xrpServer
    this._api = new RippleAPI({ server: this._xrpServer })

    this._settleThreshold = opts.settleThreshold || DEFAULT_SETTLE_THRESHOLD
    this._settleDelay = opts.settleDelay || 60 * 1000
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
    this._spspRouter.get(['/', '/.well-known/pay', '/:address', '/:address/:tag'], async ctx => {
      const details = this._spspReceiver.generateAddressAndSecret()
      const tag = ctx.params.tag && Number(ctx.params.tag)
      validateDestinationTag(tag)

      const subdomain = ctx.get('host').split('.')[0]
      const addressSegment = subdomain.split('-')[0]
      const tagSegment = subdomain.split('-')[1]
      if (!ctx.params.address) {
        validateDestinationTag(tagSegment)
      }

      const address = ctx.params.address
        ? (ctx.params.address + (tag ? `~${tag}` : ''))
        : addressCodec.encode(
            Buffer.from(base32.decode(addressSegment), 'binary'))
            + (tagSegment ? `~${tagSegment}` : '')

      const replacedDestination = details
        .destinationAccount
        .substring(0, (this._prefix + 'spsp.').length) + address + details
        .destinationAccount
        .substring((this._prefix + 'spsp.X').length)

      debug('replaced spsp destination with', replacedDestination)
      ctx.body = {
        destination_account: replacedDestination,
        shared_secret: details.sharedSecret.toString('base64'),
        ledger_info: {
          asset_code: 'XRP',  
          asset_scale: 6
        },
        receiver_info: {
          name: 'Siren receiver for "' + address + '"'
        }
      }
    })
    this._spspServer
      .use(this._spspRouter.routes())
      .use(this._spspRouter.allowedMethods())
      .listen(this._spspPort)
  }

  async _connect (from, authPacket, { ws, req }) {
    const account = this._getAccount(from)
    await account.connect()

    // Once an XRP address is associated with an account, it must not change.
    // This is to prevent anyone from stealing funds if an account is
    // compromised.

    const [ addressInPath, destinationTag ] = req.url.substring(1).split('/')
    const [ existingAddress, existingTag ] = account.getXrpAddressAndTag().split('~')

    validateDestinationTag(destinationTag)

    if (!addressCodec.isValidAddress(addressInPath)) {
      throw new Error('invalid XRP address in path. path="' + req.url + '"')
    } else if (existingAddress && existingAddress !== addressInPath) {
      throw new Error(`XRP address in path does not match stored address. path="${req.url}" stored="${existingAddress}"`)
    } else if (existingTag && existingTag !== destinationTag) {
      throw new Error(`XRP dest tag in path does not match stored tag. path="${req.url}" stored="${existingTag}"`)
    } else {
      debug('setting xrp address. address=' + addressInPath)
      await account.setXrpAddressAndTag(addressInPath + (destinationTag ? '~' + destinationTag : ''))
    }

    debug('got xrp address. address=' + account.getXrpAddressAndTag(),
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
      debug('paying to destination. destination=', destination)
      if (destination.startsWith(this._prefix + 'spsp.')) {
        debug('starts with spsp sub-prefix. prefix=' + this._prefix + 'spsp.',
          'destination=' + destination)

        const xrpAddressAndTag = destination
          .substring((this._prefix + 'spsp.').length)
          .split('.')[0]

        const [ address, tag ] = xrpAddressAndTag.split('~')        
        validateDestinationTag(tag)

        debug('parsed address. address=' + address)
        if (!addressCodec.isValidAddress(address)) {
          debug('address', address, 'is not valid')
          throw new Error('invalid destination. destination=' + destination +
            ' parsed_address=' + address)
        }

        account = new Account({
          address: xrpAddressAndTag,
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

      debug(`updated balance. old=${oldBalance.toString()} new=${balance.toString()} address=${account.getXrpAddressAndTag()}`)

      const threshold = account.addressExists()
        ? this._settleThreshold
        : BigNumber.min(this._settleThreshold, FUNDING_AMOUNT)

      if (balance.greaterThan(threshold)) {
        // careful that this balance operation persists, because otherwise it
        // could trigger a double-settlement which is potentially dangerous
        account.setBalance('0')
        const pending = this._pendingSettlements.get(account.getXrpAddressAndTag())
        const settleAmount = pending
          ? balance.add(pending.settleAmount)
          : balance

        debug('setting settleAmount. settleAmount=' + settleAmount.toString(),
          'balance=0 oldBalance=' + balance.toString())

        // clear the settlement timer
        if (pending) {
          clearTimeout(pending.timeout)
          this._pendingSettlements.delete(account.getXrpAddressAndTag())
        }

        const settleCallback = () => this._settle(account, settleAmount)
          .catch(e => debug('error during settlemnt.',
            'account=' + account.getAccount(),
            'xrp=' + account.getXrpAddressAndTag(),
            'error=', e))

        // don't await, because we don't want the fulfill call to take a long
        // time and potentially drop the fulfillment while passing back.
        if (settleAmount.gt(FUNDING_AMOUNT)) {
          debug('settling immediately')
          settleCallback() 
        } else {
          // delay on small amounts so we don't repeat settlements
          debug('settling after timeout. timeout=' + this._settleDelay)
          this._pendingSettlements.set(account.getXrpAddressAndTag(), {
            settleAmount,
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
      'xrp=' + account.getXrpAddressAndTag(),
      'balance=', balance.toString())

    const value = dropsToXrp(balance)
    const [ address, tag ] = account.getXrpAddressAndTag().split('~')
    debug('parsed address and tag. address=' + address,
      'tag=' + tag)

    validateDestinationTag(tag)
    const paymentParams = {
      source: {
        address: this._address,
        maxAmount: {
          value,
          currency: 'XRP'
        }
      },
      destination: {
        address,
        amount: {
          value,
          currency: 'XRP'
        }
      }
    }

    if (tag) paymentParams.destination.tag = Number(tag)
    const tx = await this._api.preparePayment(this._address, paymentParams)

    debug('signing settlement tx. account=', account.getAccount(),
      'xrp=' + account.getXrpAddressAndTag())
    const signed = await this._api.sign(tx.txJSON, this._secret)
    const txHash = signed.id
    const result = new Promise((resolve, reject) => {
      this._submitted[txHash] = { resolve, reject }
    })

    debug('submitting settlement tx. account=', account.getAccount(),
      'xrp=' + account.getXrpAddressAndTag())
    await this._api.submit(signed.signedTransaction)

    await result
    debug('successfully settled . account=', account.getAccount(),
      'xrp=' + account.getXrpAddressAndTag(),
      'balance=', balance.toString())
  }

  // from https://github.com/ripple/ilp-plugin-xrp-escrow/blob/master/src/plugin.js#L414
  _handleTransaction (ev) {
    if (ev.validated && ev.transaction && this._submitted[ev.transaction.hash]) {
      // give detailed error on failure
      console.log('EVENT', ev)
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
