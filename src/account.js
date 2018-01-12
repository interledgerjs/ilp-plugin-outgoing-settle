const BALANCE = a => a + ':balance'
const XRP_ADDRESS = a => a + ':xrp_address'
const BigNumber = require('bignumber.js')

class Account {
  constructor ({
    account,
    store
  }) {
    this._account = account
    this._store = store
  }

  async connect () {
    await this._store.load(BALANCE(this._account))
    await this._store.load(XRP_ADDRESS(this._account))
  }

  getAccount () {
    return this._account
  }

  getBalance () {
    return new BigNumber(this._store.get(BALANCE(this._account)) || '0')
  }

  setBalance (balance) {
    this._store.set(BALANCE(this._account), balance)
  }

  getXrpAddress () {
    return this._store.get(XRP_ADDRESS(this._account))
  }
}

module.exports = Account
