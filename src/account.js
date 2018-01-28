const BALANCE = a => a + ':balance'
const XRP_ADDRESS = a => a + ':xrp_address'
const EXISTS = a => a + ':xrp_address_exists'
const BigNumber = require('bignumber.js')

class Account {
  constructor ({
    account,
    address,
    store,
    api
  }) {
    this._account = account
    this._address = address
    this._store = store
    this._api = api
  }

  async connect () {
    if (this._account) {
      await this._store.load(XRP_ADDRESS(this._account))
    }
    if (this._address) {
      await this._loadAddress(this._address)
    }
  }

  async _loadAddress (address) {
    this._balanceKey = BALANCE(address)
    await this._store.load(this._balanceKey)

    this._addressExists = this._store.get(EXISTS(address))
    if (this._addressExists === undefined) {
      this._addressExists = false
      try {
        await this._api.getAccountInfo(account.getXrpAddressAndTag().split('~')[0])
        this._addressExists = true
      } catch (e) {}
      this._store.setCache(EXISTS(address), this._addressExists)
    }
  }

  getAccount () {
    return this._account
  }

  getBalance () {
    return new BigNumber(this._store.get(this._balanceKey) || '0')
  }

  setBalance (balance) {
    this._store.set(this._balanceKey, balance)
  }

  async setXrpAddressAndTag (address) {
    this._store.set(XRP_ADDRESS(this._account), address)
    return this._loadAddress(address)
  }

  getXrpAddressAndTag () {
    return this._store.get(XRP_ADDRESS(this._account)) || this._address || ''
  }

  addressExists () {
    return this._addressExists
  }

  setAddressExists (exists) {
    this._addressExists = exists
  }
}

module.exports = Account
