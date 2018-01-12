const BALANCE = a => a + ':balance'
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
    throw new Error('TODO')
  }
}

module.exports = Account
